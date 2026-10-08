import { testRemoteBuildHost, type RemoteReadiness, type RemoteScriptRunner } from "../remote/executor.js";
import { buildKeychainShell } from "../remote/keychain.js";
import type { RemoteBuildHost } from "../remote/settings.js";
import { buildReport, type Report } from "./report.js";
import type { Finding, IosDiscovery } from "./types.js";

export const MIN_XCODE_MAJOR = 26;
export const MIN_FREE_KB = 10 * 1024 * 1024;

/** Read-only probe. It prints counts, versions and identity *names*; never key material or passwords. */
export function readinessProbeScript(): string {
  return `set +e
printf 'MACOS\\t%s\\n' "$(sw_vers -productVersion 2>/dev/null)"
printf 'XCODE\\t%s\\n' "$(xcodebuild -version 2>/dev/null | tr '\\n' ' ')"
printf 'CLT\\t%s\\n' "$(xcode-select -p 2>/dev/null)"
printf 'XCODEBUILD\\t%s\\n' "$(command -v xcodebuild)"
printf 'XCRUN\\t%s\\n' "$(command -v xcrun)"
printf 'XCODEGEN\\t%s\\n' "$(command -v xcodegen)"
printf 'POD\\t%s\\n' "$(command -v pod)"
printf 'BUNDLE\\t%s\\n' "$(command -v bundle)"
printf 'ALTOOL\\t%s\\n' "$(xcrun --find altool 2>/dev/null)"
printf 'RUNTIMES\\t%s\\n' "$(xcrun simctl list runtimes available 2>/dev/null | grep -c '^iOS')"
printf 'SIMULATORS\\t%s\\n' "$(xcrun simctl list devices available 2>/dev/null | grep -c 'iPhone')"
IDS=$( ( ${buildKeychainShell()}
/usr/bin/security find-identity -v -p codesigning "$AGENT_TEAM_MAC_KEYCHAIN_PATH" 2>/dev/null | grep -o '"[^"]*"' ) 2>/dev/null )
printf 'IDENTITIES\\t%s\\n' "$(printf '%s' "$IDS" | tr '\\n' ';')"
printf 'PROFILES\\t%s\\n' "$(ls "$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles" 2>/dev/null | grep -c '\\.mobileprovision$')"
HOSTNAME_LOCAL="$(scutil --get ComputerName 2>/dev/null)"
xcrun xctrace list devices 2>/dev/null | awk '/^== Simulators ==/{exit} /^== Devices ==/{next} NF' | grep -vF -- "$HOSTNAME_LOCAL" | sed 's/^/DEVICE\\t/'
printf 'DISK\\t%s\\n' "$(df -Pk "$HOME" 2>/dev/null | tail -1 | awk '{print $4}')"
`;
}

export interface ReadinessValues { single: Record<string, string>; devices: Array<{ name: string; os: string; udid: string }> }

export function parseReadinessProbe(output: string): ReadinessValues {
  const single: Record<string, string> = {};
  const devices: ReadinessValues["devices"] = [];
  for (const line of output.split(/\r?\n/)) {
    const [key, ...rest] = line.split("\t");
    const value = rest.join("\t").trim();
    if (key === "DEVICE") {
      const match = /^(.+?) \(([\d.]+)\) \(([0-9A-Fa-f-]{20,})\)$/.exec(value);
      if (match) devices.push({ name: match[1], os: match[2], udid: match[3] });
    } else if (/^[A-Z]+$/.test(key) && rest.length) single[key] = value;
  }
  return { single, devices };
}

export function xcodeMajor(versionLine: string | undefined): number | undefined {
  const match = /Xcode\s+(\d+)(?:\.\d+)*/.exec(versionLine ?? "");
  return match ? Number(match[1]) : undefined;
}

function item(id: string, title: string, ok: boolean, detail: string, remedy?: string, notOkStatus: Finding["status"] = "failed"): Finding {
  return { id, title, status: ok ? "passed" : notOkStatus, detail: detail || (ok ? "ok" : "not detected"), ...(!ok && remedy ? { remedy } : {}) };
}

export interface ReadinessOptions { requiresXcodeGen?: boolean; usesCocoaPods?: boolean; usesBundler?: boolean; physicalDeviceWanted?: boolean }

/** Pure evaluation so every readiness rule is testable against fixture probe output. */
export function evaluateIosReadiness(values: ReadinessValues, options: ReadinessOptions = {}): Finding[] {
  const v = values.single;
  const major = xcodeMajor(v.XCODE);
  const findings: Finding[] = [];
  findings.push(item("macos", "macOS", Boolean(v.MACOS), v.MACOS ?? "", "Connect to a Mac; sw_vers returned nothing."));
  findings.push(item("xcode-version", `Xcode ${MIN_XCODE_MAJOR} or later`, major !== undefined && major >= MIN_XCODE_MAJOR, v.XCODE?.trim() ?? "",
    major === undefined ? "Install full Xcode from the App Store or developer.apple.com, open it once, and accept the license." : `Upgrade Xcode to ${MIN_XCODE_MAJOR} or later (Apple requires a recent Xcode for App Store uploads), then run: sudo xcode-select -s /Applications/Xcode.app`));
  findings.push(item("command-line-tools", "Xcode command-line tools", Boolean(v.CLT), v.CLT ?? "", "Run on the Mac: xcode-select --install, or sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"));
  for (const [id, name, key, remedy] of [["xcodebuild", "xcodebuild", "XCODEBUILD", "Install full Xcode and run sudo xcode-select -s /Applications/Xcode.app"], ["xcrun", "xcrun", "XCRUN", "Install the Xcode command-line tools."], ["upload-tool", "Upload tooling (xcrun altool)", "ALTOOL", "Install full Xcode; altool ships inside it. Re-select it with xcode-select if it is missing."]] as const)
    findings.push(item(id, name, Boolean(v[key]), v[key] ?? "", remedy));
  if (options.requiresXcodeGen) findings.push(item("xcodegen", "XcodeGen", Boolean(v.XCODEGEN), v.XCODEGEN ?? "", "Install on the Mac: brew install xcodegen (and make /opt/homebrew/bin visible to SSH commands)."));
  if (options.usesCocoaPods) findings.push(item("cocoapods", "CocoaPods", Boolean(v.POD), v.POD ?? "", "Install on the Mac: brew install cocoapods, and set the repository preparation command to 'pod install'."));
  if (options.usesBundler) findings.push(item("bundler", "Bundler", Boolean(v.BUNDLE), v.BUNDLE ?? "", "Install Bundler on the Mac: gem install bundler."));
  const runtimes = Number(v.RUNTIMES ?? 0), sims = Number(v.SIMULATORS ?? 0);
  findings.push(item("simulator-runtime", "iOS simulator runtime", runtimes > 0 && sims > 0, runtimes > 0 ? `${runtimes} runtime(s), ${sims} iPhone simulator(s)` : "", "Install one: Xcode → Settings → Components, or xcodebuild -downloadPlatform iOS."));
  const identities = (v.IDENTITIES ?? "").split(";").map((name) => name.trim()).filter(Boolean);
  const distribution = identities.filter((name) => /Distribution/.test(name));
  const development = identities.filter((name) => /Development|Developer/.test(name));
  findings.push(item("keychain-access", "Build Keychain access", v.IDENTITIES !== undefined, v.IDENTITIES !== undefined ? "readable" : "", "Initialize and unlock the Agent Team Build Keychain (see README → Mac Build Host)."));
  findings.push(item("signing-distribution", "Distribution signing identity", distribution.length > 0, distribution.length ? `${distribution.length} valid: ${distribution.join(", ")}` : "none in the Agent Team Build Keychain",
    "Import an Apple Distribution certificate and its private key (.p12) into the Agent Team Build Keychain on the Mac. Signing is a separate permission from upload; neither is attempted until you grant it."));
  findings.push(item("signing-development", "Development signing identity", development.length > 0, development.length ? `${development.length} valid` : "none", "Import an Apple Development certificate into the build Keychain to install on a physical device.", "pending"));
  const profiles = Number(v.PROFILES ?? 0);
  findings.push(item("provisioning", "Provisioning profiles", profiles > 0, profiles ? `${profiles} installed` : "none installed", "Automatic signing can download profiles when an App Store Connect API key is configured; otherwise install an App Store profile on the Mac.", "pending"));
  findings.push(item("physical-device", "Physical iPhone visible", values.devices.length > 0, values.devices.length ? values.devices.map((device) => `${device.name} (iOS ${device.os})`).join(", ") : "no device connected",
    "Connect an unlocked, trusted iPhone to the Mac by USB (or paired over the network) with Developer Mode enabled. Only needed for on-device testing.", options.physicalDeviceWanted ? "failed" : "pending"));
  const kb = Number(v.DISK ?? 0);
  findings.push(item("disk", "Free disk space (≥ 10 GB)", kb >= MIN_FREE_KB, kb ? `${Math.floor(kb / 1024 / 1024)} GB free` : "", "Free space on the Mac; archives and DerivedData are large."));
  return findings;
}

function baseFindings(base: RemoteReadiness): Finding[] {
  // The existing SSH and Keychain checks are reused as-is; Xcode/simulator rows are superseded by the iOS-specific ones.
  return base.items.filter((entry) => /SSH|Keychain/i.test(entry.name)).map((entry) => item(`host-${entry.name.toLowerCase().replace(/[^a-z]+/g, "-")}`, entry.name, entry.ok, entry.detail, "Fix this in Workshop Options → Mac Build Host."));
}

export interface IosReadinessDeps { run: RemoteScriptRunner; testHost?: typeof testRemoteBuildHost }

export async function inspectIosReadiness(host: RemoteBuildHost, discovery: Pick<IosDiscovery, "needsXcodeGen" | "facts">, setupCommand: string, deps: IosReadinessDeps, physicalDeviceWanted = false): Promise<Report<ReadinessValues | undefined>> {
  const title = "Mac build-host readiness";
  if (!host.enabled || !host.target) return buildReport<ReadinessValues | undefined>(title, [{ id: "host", title: "Mac Build Host", status: "blocked", detail: "No Mac Build Host is enabled.", remedy: "Open Workshop Options → Mac Build Host, save the SSH alias, test it, and enable it." }]);
  const needsXcodeGen = discovery.needsXcodeGen || Boolean(discovery.facts.xcodeGenSpec);
  const base = await (deps.testHost ?? testRemoteBuildHost)(host, setupCommand, deps.run, needsXcodeGen ? ["xcodegen"] : []);
  const connection = baseFindings(base);
  const connectionFailed = connection.some((finding) => finding.status === "failed");
  if (connectionFailed) return buildReport<ReadinessValues | undefined>(title, connection.map((finding) => finding.status === "failed" ? { ...finding, status: "blocked" as const } : finding));
  const probe = await deps.run(host, readinessProbeScript(), 45_000, 200_000);
  if (!probe.output.includes("MACOS")) return buildReport<ReadinessValues | undefined>(title, [...connection, { id: "probe", title: "Readiness probe", status: "blocked", detail: `The probe did not run (exit ${probe.code}).`, remedy: "Confirm the SSH user's shell can run /bin/zsh -s and that the Mac is awake." }]);
  const values = parseReadinessProbe(probe.output);
  const findings = [...connection, ...evaluateIosReadiness(values, { requiresXcodeGen: needsXcodeGen, usesCocoaPods: discovery.facts.usesCocoaPods === true, usesBundler: discovery.facts.usesBundler === true, physicalDeviceWanted })];
  return buildReport<ReadinessValues | undefined>(title, findings, values);
}
