import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { quote, remotePaths, sshScript, type RemoteScriptRunner } from "../remote/executor.js";
import type { RemoteBuildHost } from "../remote/settings.js";
import { classifyFailure } from "./commands.js";
import { redactSecrets } from "./redact.js";
import type { FailureClass } from "./types.js";

/**
 * Sideload an already-built app (.ipa or .app) onto whichever iPhone or iPad is connected to the Mac Build Host.
 * Nothing is built or signed here: the app must already be signed for the device (development or ad-hoc profile).
 * Device discovery prefers Xcode's devicectl and falls back to ios-deploy, then libimobiledevice.
 */

export type SideloadTool = "devicectl" | "ios-deploy" | "libimobiledevice";
export const SIDELOAD_TOOLS: SideloadTool[] = ["devicectl", "ios-deploy", "libimobiledevice"];

export interface ConnectedDevice {
  udid: string;
  name: string;
  os?: string;
  model?: string;
  /** The tool that saw the device; it is the one used to install. */
  tool: SideloadTool;
  /** False when the device is visible but cannot take an install yet (not trusted, Developer Mode off). */
  ready: boolean;
  note?: string;
}

export interface DeviceProbe { devices: ConnectedDevice[]; tools: Record<SideloadTool, boolean> }

const UDID = /^[0-9A-Fa-f-]{20,64}$/;

/** Read-only: lists devices with each available tool. Prints names, OS versions and UDIDs only. */
export function deviceProbeScript(): string {
  return `set +e
DC=$(xcrun --find devicectl 2>/dev/null)
printf 'TOOL\\tdevicectl\\t%s\\n' "$DC"
if [ -n "$DC" ]; then
  T=$(mktemp)
  xcrun devicectl list devices --json-output "$T" >/dev/null 2>&1
  printf '@@DEVICECTL_BEGIN\\n'; cat "$T" 2>/dev/null; printf '\\n@@DEVICECTL_END\\n'
  rm -f "$T"
fi
ID=$(command -v ios-deploy)
printf 'TOOL\\tios-deploy\\t%s\\n' "$ID"
[ -n "$ID" ] && ios-deploy --detect --timeout 3 2>/dev/null | grep 'Found ' | sed 's/^/IOSDEPLOY\\t/'
IM=$(command -v ideviceinstaller)
[ -n "$IM" ] && [ -z "$(command -v idevice_id)" ] && IM=""
printf 'TOOL\\tlibimobiledevice\\t%s\\n' "$IM"
if [ -n "$IM" ]; then
  for U in $(idevice_id -l 2>/dev/null); do
    printf 'IDEVICE\\t%s\\t%s\\t%s\\t%s\\n' "$U" "$(ideviceinfo -u "$U" -k DeviceName 2>/dev/null)" "$(ideviceinfo -u "$U" -k ProductVersion 2>/dev/null)" "$(ideviceinfo -u "$U" -k ProductType 2>/dev/null)"
  done
fi
`;
}

interface DevicectlDevice {
  identifier?: string;
  connectionProperties?: { pairingState?: string; tunnelState?: string; transportType?: string };
  deviceProperties?: { name?: string; osVersionNumber?: string; developerModeStatus?: string };
  hardwareProperties?: { udid?: string; platform?: string; reality?: string; marketingName?: string; productType?: string };
}

function devicectlDevices(json: string): ConnectedDevice[] {
  let parsed: { result?: { devices?: DevicectlDevice[] } };
  try { parsed = JSON.parse(json) as typeof parsed; } catch { return []; }
  const found: ConnectedDevice[] = [];
  for (const device of parsed.result?.devices ?? []) {
    const hardware = device.hardwareProperties ?? {}, connection = device.connectionProperties ?? {}, props = device.deviceProperties ?? {};
    if (hardware.platform !== "iOS" || (hardware.reality && hardware.reality !== "physical")) continue;
    // devicectl also lists devices paired in the past that are not reachable now.
    if (connection.tunnelState === "unavailable") continue;
    const udid = hardware.udid ?? device.identifier;
    if (!udid || !UDID.test(udid)) continue;
    const note = connection.pairingState && connection.pairingState !== "paired" ? "Not trusted yet: unlock it and tap Trust on 'Trust This Computer'."
      : props.developerModeStatus === "disabled" ? "Developer Mode is off: Settings → Privacy & Security → Developer Mode, then restart it." : undefined;
    found.push({ udid, name: props.name ?? hardware.marketingName ?? "iOS device", os: props.osVersionNumber, model: hardware.marketingName ?? hardware.productType, tool: "devicectl", ready: !note, ...(note ? { note } : {}) });
  }
  return found;
}

export function parseDeviceProbe(output: string): DeviceProbe {
  const tools: Record<SideloadTool, boolean> = { devicectl: false, "ios-deploy": false, libimobiledevice: false };
  const byTool: Record<SideloadTool, ConnectedDevice[]> = { devicectl: [], "ios-deploy": [], libimobiledevice: [] };
  const begin = output.indexOf("@@DEVICECTL_BEGIN"), end = output.indexOf("@@DEVICECTL_END");
  if (begin >= 0 && end > begin) byTool.devicectl = devicectlDevices(output.slice(begin + "@@DEVICECTL_BEGIN".length, end).trim());
  const rest = begin >= 0 && end > begin ? output.slice(0, begin) + output.slice(end) : output;
  for (const line of rest.split(/\r?\n/)) {
    const [kind, ...fields] = line.split("\t");
    if (kind === "TOOL" && SIDELOAD_TOOLS.includes(fields[0] as SideloadTool)) tools[fields[0] as SideloadTool] = Boolean(fields[1]?.trim());
    if (kind === "IOSDEPLOY") {
      // [....] Found 00008110-001A2B3C4D5E6F70 (D63AP, iPhone 13 Pro, iphoneos, arm64e, 17.0, 21A329) a.k.a. 'Jake's iPhone' connected through USB.
      const match = /Found ([0-9A-Fa-f-]{20,64}) \(([^)]*)\) a\.k\.a\. '(.*)' connected/.exec(fields.join("\t"));
      if (!match) continue;
      const details = match[2].split(",").map((part) => part.trim());
      byTool["ios-deploy"].push({ udid: match[1], name: match[3], model: details[1], os: details.find((part) => /^\d+(\.\d+)+$/.test(part)), tool: "ios-deploy", ready: true });
    }
    if (kind === "IDEVICE" && UDID.test(fields[0] ?? "")) byTool.libimobiledevice.push({ udid: fields[0], name: fields[1]?.trim() || "iOS device", os: fields[2]?.trim() || undefined, model: fields[3]?.trim() || undefined, tool: "libimobiledevice", ready: true });
  }
  // Each device is reported once, by the most capable tool that saw it.
  const devices: ConnectedDevice[] = [];
  const key = (udid: string) => udid.toLowerCase().replaceAll("-", "");
  for (const tool of SIDELOAD_TOOLS) for (const device of byTool[tool]) if (!devices.some((seen) => key(seen.udid) === key(device.udid))) devices.push(device);
  return { devices, tools };
}

export function chooseDevice(probe: DeviceProbe, options: { udid?: string; tool?: SideloadTool } = {}): { device?: ConnectedDevice; reason?: string; remedy?: string } {
  const candidates = options.tool ? probe.devices.filter((device) => device.tool === options.tool) : probe.devices;
  const describe = (list: ConnectedDevice[]) => list.map((device) => `${device.name}${device.os ? ` (iOS ${device.os})` : ""} ${device.udid}`).join("; ");
  if (options.tool && !probe.tools[options.tool]) return { reason: `${options.tool} is not installed on the Mac.`, remedy: installHint(options.tool) };
  if (!candidates.length) {
    if (!SIDELOAD_TOOLS.some((tool) => probe.tools[tool])) return { reason: "No device tool is available on the Mac (devicectl, ios-deploy or libimobiledevice).", remedy: "Install Xcode 15 or later (for devicectl), or run: brew install ios-deploy, or brew install libimobiledevice ideviceinstaller." };
    return { reason: options.tool && probe.devices.length ? `No device is visible to ${options.tool}. Connected: ${describe(probe.devices)}.` : "No iPhone or iPad is connected to the Mac.", remedy: "Connect an unlocked iPhone or iPad to the Mac by USB (or pair it over the network in Xcode), tap Trust, and turn on Developer Mode." };
  }
  if (options.udid) {
    const match = candidates.find((device) => device.udid.toLowerCase() === options.udid!.toLowerCase());
    if (!match) return { reason: `Device ${options.udid} is not connected. Connected: ${describe(candidates)}.`, remedy: "Connect that device, or pass one of the connected UDIDs." };
    return match.ready ? { device: match } : { reason: `${match.name} is connected but not ready.`, remedy: match.note };
  }
  const ready = candidates.filter((device) => device.ready);
  if (!ready.length) return { reason: `${describe(candidates)} ${candidates.length > 1 ? "are" : "is"} connected but not ready.`, remedy: candidates.map((device) => device.note).filter(Boolean).join(" ") };
  if (ready.length > 1) return { reason: `Several devices are connected: ${describe(ready)}.`, remedy: "Pick one with --device <UDID> (or the device argument)." };
  return { device: ready[0] };
}

function installHint(tool: SideloadTool): string {
  return tool === "devicectl" ? "Install Xcode 15 or later and select it with sudo xcode-select -s /Applications/Xcode.app." : tool === "ios-deploy" ? "Run on the Mac: brew install ios-deploy" : "Run on the Mac: brew install libimobiledevice ideviceinstaller";
}

/** Shell expression for an app path already on the Mac: absolute, or under the home folder with ~/. */
export function macAppPath(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!/\.(ipa|app)$/i.test(trimmed)) throw new Error("The app must be a .ipa file or a .app bundle.");
  if (/[\0\r\n]/.test(trimmed) || trimmed.length > 500) throw new Error("That app path is not valid.");
  if (trimmed.startsWith("~/")) return `"$HOME"/${quote(trimmed.slice(2))}`;
  if (trimmed.startsWith("/")) return quote(trimmed);
  throw new Error("A path on the Mac must be absolute or start with ~/.");
}

interface InstallStep { label: string; command: string; display: string }

function installSteps(tool: SideloadTool, udid: string, launch: boolean): InstallStep[] {
  if (!UDID.test(udid)) throw new Error(`Invalid device UDID: ${udid}`);
  const device = quote(udid);
  switch (tool) {
    case "devicectl": return [
      { label: "xcrun devicectl device install app", command: `xcrun devicectl device install app --device ${device} "$APP"`, display: `xcrun devicectl device install app --device ${udid} <app>` },
      ...(launch ? [{ label: "xcrun devicectl device process launch", command: `xcrun devicectl device process launch --device ${device} "$BUNDLE_ID"`, display: `xcrun devicectl device process launch --device ${udid} <bundle id>` }] : []),
    ];
    case "ios-deploy": return [
      { label: "ios-deploy install", command: `ios-deploy --id ${device} --bundle "$APP"`, display: `ios-deploy --id ${udid} --bundle <app>` },
      ...(launch ? [{ label: "ios-deploy launch", command: `ios-deploy --id ${device} --bundle "$APP" --noinstall --debug --justlaunch`, display: `ios-deploy --id ${udid} --bundle <app> --noinstall --debug --justlaunch` }] : []),
    ];
    // ideviceinstaller takes an .ipa, so a bare .app is wrapped in Payload/ first. It cannot launch apps.
    case "libimobiledevice": return [
      { label: "ideviceinstaller install", command: `ideviceinstaller -u ${device} -i "$IPA"`, display: `ideviceinstaller -u ${udid} -i <ipa>` },
    ];
  }
}

export function sideloadScript(appExpr: string, workDir: string, tool: SideloadTool, udid: string, launch: boolean, nonce: string): string {
  const mark = (name: string, test: string, valueExpr = "1") => `if ${test}; then printf '@@${nonce}:${name}=%s\\n' ${valueExpr}; fi`;
  const steps = installSteps(tool, udid, launch).map((step) => `if [ "$code" -eq 0 ]; then
  printf '\\n$ %s\\n' ${quote(step.label)} >>"$output"
  ${step.command} >>"$output" 2>&1 </dev/null; code=$?
fi`).join("\n");
  const verify = tool === "devicectl" ? `${mark("INSTALLED", `grep -q 'App installed' "$output"`)}\n${launch ? mark("LAUNCHED", `grep -q 'Launched application' "$output"`) : ""}`
    : tool === "ios-deploy" ? `${mark("INSTALLED", `grep -Eq 'Installed package|\\[100%\\]' "$output"`)}\n${launch ? mark("LAUNCHED", "true") : ""}`
    : mark("INSTALLED", `grep -Eq 'Install: Complete|Install - Complete|Complete$' "$output"`);
  return `set +e
output=$(mktemp)
W=${workDir}
trap 'rm -rf "$output" "$W"' EXIT
mkdir -p "$W"
code=0
SRC=${appExpr}
case "$SRC" in
  *.ipa|*.IPA)
    [ -f "$SRC" ] || { printf 'No .ipa at %s\\n' "$SRC" >>"$output"; code=2; }
    if [ "$code" -eq 0 ]; then unzip -q -o "$SRC" -d "$W/unzipped" >>"$output" 2>&1 || code=3; fi
    APP=$(find "$W/unzipped/Payload" -maxdepth 1 -name '*.app' 2>/dev/null | head -1)
    IPA="$SRC" ;;
  *)
    APP="$SRC"; IPA="" ;;
esac
if [ "$code" -eq 0 ] && [ ! -f "$APP/Info.plist" ]; then printf 'No app bundle with an Info.plist was found in %s\\n' "$SRC" >>"$output"; code=4; fi
if [ "$code" -eq 0 ]; then
  for K in CFBundleIdentifier CFBundleShortVersionString CFBundleVersion CFBundleDisplayName CFBundleName; do
    V=$(/usr/libexec/PlistBuddy -c "Print :$K" "$APP/Info.plist" 2>/dev/null); printf '@@${nonce}:%s=%s\\n' "$K" "$V"
  done
  BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Info.plist" 2>/dev/null)
  [ -n "$BUNDLE_ID" ] || { printf 'No app bundle with an Info.plist CFBundleIdentifier was found in %s\n' "$SRC" >>"$output"; code=4; }
fi
${tool === "libimobiledevice" ? `if [ "$code" -eq 0 ] && [ -z "$IPA" ]; then
  mkdir -p "$W/pkg/Payload" && cp -R "$APP" "$W/pkg/Payload/" && ( cd "$W/pkg" && zip -qry "$W/app.ipa" Payload ) >>"$output" 2>&1 && IPA="$W/app.ipa" || code=5
fi` : ""}
${steps}
cat "$output"
printf '\\n@@${nonce}:EXIT=%s\\n' "$code"
if [ "$code" -eq 0 ]; then
${verify}
fi
exit 0
`;
}

const SIDELOAD_RULES: Array<[RegExp, FailureClass, string]> = [
  [/0xe8008015|0xe800801c|valid provisioning profile for this executable was not found|ApplicationVerificationFailed|not (?:included|registered) in (?:the|its) provisioning profile|unable to install.*provision/i, "provisioning", "The app is not signed for this device. Rebuild it with a development or ad-hoc profile that includes this device's UDID, or distribute it through TestFlight. App Store exports never install directly."],
  [/Developer Mode|0xe800800a|DeveloperModeNotEnabled/i, "environment", "Turn on Developer Mode on the device (Settings → Privacy & Security → Developer Mode), restart it, and confirm the prompt."],
  [/device is locked|passcode|DeviceLocked|kAMDMobileImageMounterDeviceLocked|0xe80000e2/i, "environment", "Unlock the device and keep it awake, then retry."],
  [/not paired|pairing (?:failed|record)|PasswordProtected|InvalidHostID|trust this computer/i, "environment", "Unlock the device and tap Trust on 'Trust This Computer', then retry."],
  [/MinimumOSVersion|requires a newer version of iOS|DeviceOSVersionTooLow|0xe8000032/i, "environment", "The app needs a newer iOS than the device runs. Update the device or rebuild with a lower deployment target."],
  [/UIRequiredDeviceCapabilities|DeviceFamily|not compatible with this device/i, "environment", "The app does not support this device type (iPhone vs iPad, or a required capability)."],
  [/No .ipa at|No app bundle with an Info.plist/i, "verification", "Check the path: it must point to a .ipa file or a .app bundle."],
];

export function classifySideloadFailure(output: string): { failureClass: FailureClass; remedy: string } {
  for (const [pattern, failureClass, remedy] of SIDELOAD_RULES) if (pattern.test(output)) return { failureClass, remedy };
  return classifyFailure(output);
}

export interface SideloadRequest {
  /** A .ipa file or .app bundle: on this computer, or on the Mac when onMac is true. */
  app: string;
  onMac?: boolean;
  udid?: string;
  tool?: SideloadTool;
  launch?: boolean;
  dryRun?: boolean;
}

export interface SideloadResult {
  operation: "sideload";
  status: "success" | "failed" | "blocked" | "dry-run";
  verified: boolean;
  summary: string;
  device?: ConnectedDevice;
  app?: { bundleId?: string; name?: string; version?: string; build?: string };
  launched?: boolean;
  failureClass?: FailureClass;
  remedy?: string;
  commands: string[];
  output?: string;
}

export type FileUploader = (host: RemoteBuildHost, localPath: string, remoteDir: string) => Promise<string>;
export interface SideloadDeps { host: RemoteBuildHost; run?: RemoteScriptRunner; uploadApp?: FileUploader; preferredUdid?: string; newId?: () => string }

export async function listConnectedDevices(host: RemoteBuildHost, run: RemoteScriptRunner = sshScript): Promise<DeviceProbe & { error?: string }> {
  const probe = await run(host, deviceProbeScript(), 60_000, 400_000);
  if (!probe.output.includes("TOOL\t")) return { devices: [], tools: { devicectl: false, "ios-deploy": false, libimobiledevice: false }, error: `The device probe did not run on the Mac (exit ${probe.code}). ${redactSecrets(probe.output.slice(-500))}`.trim() };
  return parseDeviceProbe(probe.output);
}

/** Streams a local .ipa (or a tarred .app bundle) into a folder on the Mac; returns the remote path as a shell expression. */
export async function uploadAppToMac(host: RemoteBuildHost, localPath: string, remoteDir: string): Promise<string> {
  const info = await stat(localPath);
  const name = path.basename(localPath.replace(/[\\/]+$/, ""));
  if (!/^[A-Za-z0-9 _.()+-]{1,120}\.(ipa|app)$/i.test(name)) throw new Error(`Rename the app to a plain file name before sideloading: ${name}`);
  const sshArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...(host.port ? ["-p", String(host.port)] : []), host.target];
  const remote = `${remoteDir}/${quote(name)}`;
  await new Promise<void>((resolve, reject) => {
    const sink = spawn("ssh", [...sshArgs, info.isDirectory() ? `mkdir -p ${remoteDir} && tar -xf - -C ${remoteDir}` : `mkdir -p ${remoteDir} && cat > ${remote}`], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let error = "", sourceDone = false, sinkCode: number | null = null;
    const finish = () => { if (sourceDone && sinkCode !== null) sinkCode === 0 ? resolve() : reject(new Error(`Copying the app to the Mac failed: ${error.slice(-1_000)}`)); };
    sink.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    sink.on("error", reject);
    sink.stdin.on("error", (streamError) => reject(new Error(`Copying the app to the Mac failed: the connection closed (${streamError.message}).`)));
    sink.on("close", (code) => { sinkCode = code; finish(); });
    if (info.isDirectory()) {
      // A .app is a folder, so it travels as a tar stream (cwd instead of -C: GNU tar reads "C:\..." as a remote host).
      const pack = spawn("tar", ["-cf", "-", name], { cwd: path.dirname(path.resolve(localPath)), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      pack.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
      pack.on("error", reject);
      pack.stdout.on("error", () => undefined);
      pack.on("close", (code) => { if (code !== 0) reject(new Error(`Packing the app failed: ${error.slice(-1_000)}`)); sourceDone = true; finish(); });
      pack.stdout.pipe(sink.stdin);
    } else {
      const file = createReadStream(localPath);
      file.on("error", reject);
      file.on("end", () => { sourceDone = true; finish(); });
      file.pipe(sink.stdin);
    }
  });
  return remote;
}

function parseMarkers(output: string, nonce: string): { markers: Record<string, string>; text: string } {
  const markers: Record<string, string> = {};
  const lines: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith(`@@${nonce}:`)) { const rest = line.slice(nonce.length + 3); const at = rest.indexOf("="); if (at > 0) markers[rest.slice(0, at)] = rest.slice(at + 1).trim(); }
    else lines.push(line);
  }
  return { markers, text: lines.join("\n").trim() };
}

export async function sideloadApp(request: SideloadRequest, deps: SideloadDeps): Promise<SideloadResult> {
  const blocked = (summary: string, remedy?: string, failureClass: FailureClass = "environment", commands: string[] = []): SideloadResult => ({ operation: "sideload", status: "blocked", verified: false, summary, remedy, failureClass, commands });
  if (!deps.host.enabled || !deps.host.target) return blocked("No Mac Build Host is enabled.", "Open Workshop Options → Mac Build Host, save the SSH alias, test it, and enable it.");
  if (request.tool && !SIDELOAD_TOOLS.includes(request.tool)) return blocked(`Unknown tool ${request.tool}.`, `Use one of: ${SIDELOAD_TOOLS.join(", ")}.`);
  if (request.udid && !UDID.test(request.udid)) return blocked(`'${request.udid}' is not a device UDID.`, "List devices first, then pass one of their UDIDs.");
  let appExpr: string | undefined;
  if (request.onMac) {
    try { appExpr = macAppPath(request.app); } catch (error) { return blocked(error instanceof Error ? error.message : String(error), "Pass the .ipa or .app path on the Mac, absolute or starting with ~/.", "verification"); }
  } else {
    if (!/\.(ipa|app)[\\/]*$/i.test(request.app)) return blocked("The app must be a .ipa file or a .app bundle.", "Pass the path of a .ipa file or a .app folder.", "verification");
    const info = await stat(request.app).catch(() => undefined);
    if (!info) return blocked(`${request.app} does not exist on this computer.`, "Check the path, or pass --on-mac if the app is already on the Mac.", "verification");
  }
  const launch = request.launch === true;
  if (request.dryRun) {
    const tool = request.tool ?? "devicectl", udid = request.udid ?? "00000000-0000000000000000";
    const commands = [...(request.onMac ? [] : [`copy ${path.basename(request.app)} to the Mac`]), ...installSteps(tool, udid, launch).map((step) => step.display.replaceAll(udid, request.udid ?? "<connected device>"))];
    return { operation: "sideload", status: "dry-run", verified: false, summary: `Dry run: would install ${path.basename(request.app)} on ${request.udid ?? "the connected device"} with ${request.tool ?? "devicectl (falling back to ios-deploy, then libimobiledevice)"}. Nothing was copied or installed.`, commands };
  }

  const run = deps.run ?? sshScript;
  const probe = await listConnectedDevices(deps.host, run);
  if (probe.error) return { ...blocked(probe.error, "Run the Mac readiness check; confirm the Mac is awake and the SSH alias works."), failureClass: "environment" };
  const picked = chooseDevice(probe, { udid: request.udid ?? (probe.devices.some((device) => device.udid.toLowerCase() === deps.preferredUdid?.toLowerCase()) ? deps.preferredUdid : undefined), tool: request.tool });
  if (!picked.device) return blocked(picked.reason ?? "No device is available.", picked.remedy);
  const device = picked.device;
  const id = (deps.newId ?? (() => randomUUID().replaceAll("-", "")))();
  const nonce = randomUUID().replaceAll("-", "");
  const paths = remotePaths(deps.host, id);
  const commands = [...(request.onMac ? [] : [`copy ${path.basename(request.app)} to the Mac`]), ...installSteps(device.tool, device.udid, launch).map((step) => step.display)];
  try {
    if (!request.onMac) appExpr = await (deps.uploadApp ?? uploadAppToMac)(deps.host, request.app, `${paths.job}/upload`);
    const execution = await run(deps.host, sideloadScript(appExpr!, paths.job, device.tool, device.udid, launch, nonce), 420_000, 300_000);
    const { markers, text } = parseMarkers(execution.output, nonce);
    const output = redactSecrets(text).slice(-12_000);
    const app = { bundleId: markers.CFBundleIdentifier || undefined, name: markers.CFBundleDisplayName || markers.CFBundleName || undefined, version: markers.CFBundleShortVersionString || undefined, build: markers.CFBundleVersion || undefined };
    const label = `${app.name ?? app.bundleId ?? path.basename(request.app)}${app.version ? ` ${app.version}${app.build ? ` (${app.build})` : ""}` : ""}`;
    const exit = markers.EXIT !== undefined ? Number(markers.EXIT) : NaN;
    if (!Number.isFinite(exit)) return { operation: "sideload", status: "failed", verified: false, summary: "The install produced no completion marker, so it is not counted as successful.", failureClass: execution.code === 255 ? "environment" : "verification", remedy: execution.code === 255 ? "The SSH connection to the Mac failed; confirm the Mac is awake and reachable." : "Inspect the output below.", device, commands, output: output || redactSecrets(execution.output.slice(-1_500)) };
    if (exit !== 0) {
      const classified = classifySideloadFailure(output);
      const first = output.split(/\r?\n/).filter((line) => /error|fail|denied|unable|not found|No /i.test(line)).slice(-2).join(" | ");
      return { operation: "sideload", status: "failed", verified: false, summary: `Installing ${label} on ${device.name} failed (${classified.failureClass}${first ? `: ${first.slice(0, 300)}` : ""}).`, failureClass: classified.failureClass, remedy: classified.remedy, device, app, commands, output };
    }
    if (!markers.INSTALLED) return { operation: "sideload", status: "failed", verified: false, summary: `${device.tool} exited 0 but did not confirm the install, so it is not counted as successful.`, failureClass: "verification", remedy: "Inspect the output below.", device, app, commands, output };
    const launched = launch ? Boolean(markers.LAUNCHED) : undefined;
    const launchNote = launch ? (device.tool === "libimobiledevice" ? " libimobiledevice cannot launch apps; open it on the device." : launched ? " Launched it." : " The launch was not confirmed.") : "";
    return { operation: "sideload", status: "success", verified: true, summary: `Installed ${label} on ${device.name}${device.os ? ` (iOS ${device.os})` : ""} with ${device.tool}.${launchNote}`, device, app, launched, commands, output };
  } catch (error) {
    return { operation: "sideload", status: "failed", verified: false, summary: error instanceof Error ? error.message : String(error), failureClass: "environment", remedy: "Check the Mac connection and the app path, then retry.", device, commands };
  } finally {
    await run(deps.host, `rm -rf ${paths.job}\n`).catch(() => undefined);
  }
}
