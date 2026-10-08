import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { git } from "../coding/git.js";
import { collectFiles, downloadAttachments, quote, remotePaths, sshScript, upload, type RemoteScriptRunner } from "../remote/executor.js";
import { buildKeychainShell, keychainRedactionPipeline, keychainSecretLookup } from "../remote/keychain.js";
import type { RemoteBuildHost, RemoteProjectSettings } from "../remote/settings.js";
import * as cmd from "./commands.js";
import { xcodebuildContainer, listProjectFiles } from "./discovery.js";
import { parseReadinessProbe, readinessProbeScript } from "./readiness.js";
import { redactSecrets } from "./redact.js";
import { runsDir, saveOperationRecord, updateIosState, recordStep, type IosReleaseSettings, type IosReleaseState } from "./store.js";
import type { FailureClass, IosDiscovery, OperationName, OperationResult, RunContext } from "./types.js";

const OUTPUT_LIMIT = 12_000;

export interface OperationDeps {
  repo: string;
  host: RemoteBuildHost;
  project: RemoteProjectSettings;
  settings: IosReleaseSettings;
  state: IosReleaseState;
  run?: RemoteScriptRunner;
  uploadSource?: (root: string, host: RemoteBuildHost, remoteSource: string) => Promise<void>;
  downloadAttachments?: typeof downloadAttachments;
  newId?: () => string;
  newNonce?: () => string;
  persist?: boolean;
}

export interface OperationRequest { operation: OperationName; dryRun?: boolean; scheme?: string; validateOnly?: boolean; testScope?: "unit" | "ui" | "all"; /** Simulator model name, for example "iPhone 17 Pro Max". */ simulator?: string; /** Runs UI tests that save App Store screenshots (they skip themselves otherwise). */ captureScreenshots?: boolean }

/** Identity of the exact tree an operation used, so evidence is never attributed to different code. */
export async function captureRunContext(root: string): Promise<RunContext> {
  const commit = await git(root, ["rev-parse", "HEAD"]).catch(() => undefined);
  const status = await git(root, ["status", "--porcelain", "--untracked-files=all"]).catch(() => "");
  // Identity is the content of every file that would be uploaded, so committing identical files keeps the same hash.
  // release/ (store metadata) and docs/ (the public website) do not change what the app is.
  const hash = createHash("sha256");
  const files = (await listProjectFiles(root).catch(() => [] as string[])).filter((file) => !file.startsWith("release/") && !file.startsWith("docs/")).sort();
  const contents = await Promise.all(files.map((file) => readFile(path.join(root, file)).catch(() => Buffer.alloc(0))));
  files.forEach((file, index) => {
    // Git on Windows converts line endings when switching branches; that must not change the code identity.
    const raw = contents[index];
    const text = !raw.subarray(0, 8000).includes(0);
    const normalized = text ? Buffer.from(raw.toString("latin1").split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)), "latin1") : raw;
    hash.update(file + "|" + normalized.length + "|").update(normalized);
  });
  return { root, commit, dirty: Boolean(status), treeHash: hash.digest("hex"), at: new Date().toISOString() };
}

const SIGNING_OPS: OperationName[] = ["build-release", "archive", "export", "install-device"];
const SOURCE_OPS: OperationName[] = ["generate-project", "build-simulator", "test-simulator", "build-release", "archive", "install-device"];

function resolveScheme(request: OperationRequest, discovery: IosDiscovery, settings: IosReleaseSettings): string | undefined {
  const wanted = request.scheme ?? settings.scheme;
  if (wanted) return wanted;
  const app = discovery.appTarget?.name;
  return app && discovery.schemes.includes(app) ? app : discovery.schemes[0];
}

interface Gate { blocked?: { failureClass: FailureClass; summary: string; remedy: string }; scheme?: string; teamId?: string; useApiKey: boolean }

/** Pure policy check shared by real runs and dry runs. Signing and upload are separate user-granted permissions. */
export function gateOperation(request: OperationRequest, discovery: IosDiscovery, deps: Pick<OperationDeps, "host" | "settings" | "state">, context: RunContext): Gate {
  const { settings, state } = deps;
  const block = (failureClass: FailureClass, summary: string, remedy: string): Gate => ({ blocked: { failureClass, summary, remedy }, useApiKey: Boolean(settings.apiKey) });
  const op = request.operation;
  if (!deps.host.enabled || !deps.host.target) return block("environment", "No Mac Build Host is enabled.", "Open Workshop Options → Mac Build Host, save the SSH alias, test it, and enable it.");
  if (discovery.blockers.length) return block("environment", discovery.blockers.map((b) => b.title).join("; "), discovery.blockers.map((b) => b.remedy).filter(Boolean).join(" "));
  if (request.simulator !== undefined && !/^[A-Za-z0-9 ().-]{1,60}$/.test(request.simulator)) return block("environment", "The simulator name is not valid.", "Use a simulator model name such as iPhone 17 Pro Max.");
  const scheme = resolveScheme(request, discovery, settings);
  const needsProject = op !== "export" && op !== "upload";
  if (needsProject && !scheme) return block("environment", "No scheme could be determined.", "Save a scheme in iOS release settings, or add a shared scheme to the project.");
  if (needsProject && op !== "generate-project" && !xcodebuildContainer(discovery)) return block("environment", "No Xcode project or workspace is available to build.", "Add the project, or fix the XcodeGen spec name so the project can be generated.");
  if (SIGNING_OPS.includes(op) && !settings.permissions.signing) return block("permission-denied", `${op} requires signing permission, which has not been granted.`, "Grant it yourself: npm run ios -- grant signing --repo <path>. The agent cannot grant permissions.");
  if (op === "upload" && !settings.permissions.upload) return block("permission-denied", "Upload requires upload permission, which has not been granted.", "Grant it yourself when ready: npm run ios -- grant upload --repo <path>. Uploading is separate from signing and is never automatic.");
  const teamId = settings.teamId ?? discovery.appTarget?.developmentTeam;
  if ((op === "archive" || op === "build-release" || op === "install-device") && !teamId) return block("account-team", "No Apple Developer Team ID is configured.", "Save your 10-character Team ID in iOS release settings (npm run ios -- settings --team <ID>). The agent will not guess it.");
  if (op === "upload" && !settings.apiKey) return block("credentials-missing", "No App Store Connect API key is mapped.", "Store the key ID, issuer ID and base64 .p8 as Keychain secrets on the Mac, then map their names with npm run ios -- settings --api-key-id-secret … --api-issuer-secret … --api-key-secret …");
  if (op === "export") {
    if (!state.lastArchive) return block("verification", "There is no verified archive to export.", "Run the archive step first.");
    if (state.lastArchive.treeHash !== context.treeHash) return block("verification", "The verified archive was built from an earlier version of the code.", "Archive again from the current tree, then export.");
  }
  if (op === "upload") {
    if (!state.lastExport) return block("verification", "There is no verified export to upload.", "Run the export step first.");
    if (state.lastExport.treeHash !== context.treeHash) return block("verification", "The verified export was built from an earlier version of the code.", "Archive and export again from the current tree.");
    const last = state.lastUpload, target = discovery.appTarget;
    if (last && target && last.marketingVersion === target.marketingVersion && last.buildNumber !== undefined && target.buildNumber !== undefined && Number(target.buildNumber) <= Number(last.buildNumber) && !request.validateOnly)
      return block("duplicate-build", `Build ${target.buildNumber} was already uploaded for version ${target.marketingVersion}.`, "Increment the build number, then archive and export again.");
  }
  return { scheme, teamId, useApiKey: Boolean(settings.apiKey) && (op === "archive" || op === "export" || op === "build-release" || op === "install-device") };
}

interface Step { command: cmd.RemoteCommand; before?: string }
interface Plan { steps: Step[]; needsSource: boolean; needsApiKey: boolean; verify: string; releaseId?: string; usesProjectSecrets: boolean; preScript?: string }

function homePath(relative: string): string { return `"$HOME"/${quote(relative)}`; }
function macPath(host: RemoteBuildHost, relative: string): string { return homePath(`${host.root}/${relative}`); }

function planFor(request: OperationRequest, discovery: IosDiscovery, gate: Gate, deps: Pick<OperationDeps, "host" | "settings" | "state" | "project">, id: string, nonce: string, extra: { deviceUdid?: string; simulatorDestination?: string } = {}): Plan {
  const host = deps.host;
  const paths = remotePaths(host, id);
  const container = xcodebuildContainer(discovery);
  const scheme = gate.scheme!;
  const mark = (name: string, test: string, valueExpr = "1") => `if ${test}; then printf '@@${nonce}:${name}=%s\\n' ${valueExpr}; fi`;
  const built = (cfg: string) => `${paths.cache}/DerivedData/Build/Products/${cfg}`;
  const signing = { teamId: gate.teamId, useApiKey: gate.useApiKey };
  const deviceUdid = extra.deviceUdid;
  const generate: Step[] = discovery.needsXcodeGen && discovery.xcodeGenSpec && request.operation !== "generate-project" ? [{ command: cmd.xcodegenGenerate(discovery.xcodeGenSpec) }] : [];
  const succeeded = (word: string) => mark("SUCCEEDED", `grep -q '\\*\\* ${word} SUCCEEDED \\*\\*' "$output"`);
  const base = { needsSource: SOURCE_OPS.includes(request.operation), needsApiKey: false, usesProjectSecrets: SOURCE_OPS.includes(request.operation) };
  switch (request.operation) {
    case "generate-project": {
      const project = container?.file ?? `${discovery.xcodeGenProjectName ?? "Project"}.xcodeproj`;
      return { ...base, steps: [{ command: cmd.xcodegenGenerate(discovery.xcodeGenSpec ?? "project.yml") }], verify: mark("PROJECT", `[ -f ${quote(`${project}/project.pbxproj`)} ]`) };
    }
    case "build-simulator":
      return { ...base, steps: [...generate, { command: cmd.simulatorBuild(container!, scheme, paths.cache) }], verify: `${succeeded("BUILD")}\n${mark("APP", `[ -n "$(find ${built("Debug-iphonesimulator")} -maxdepth 1 -name '*.app' 2>/dev/null | head -1)" ]`)}` };
    case "test-simulator": {
      const only = request.testScope === "unit" ? discovery.testTargets.unit : request.testScope === "ui" || request.captureScreenshots ? discovery.testTargets.ui : [];
      return { ...base, steps: [...generate, { command: cmd.simulatorTest(container!, scheme, extra.simulatorDestination ?? SIM_PLACEHOLDER, `${paths.job}/result.xcresult`, paths.cache, only, request.captureScreenshots) }], verify: `${succeeded("TEST")}\n${mark("XCRESULT", `[ -d ${paths.job}/result.xcresult ]`)}` };
    }
    case "build-release":
      return { ...base, needsApiKey: gate.useApiKey, steps: [...generate, { command: cmd.releaseBuild(container!, scheme, paths.cache, signing) }], verify: `${succeeded("BUILD")}\n${mark("CODESIGN", `APP=$(find ${built("Release-iphoneos")} -maxdepth 1 -name '*.app' 2>/dev/null | head -1); [ -n "$APP" ] && /usr/bin/codesign --verify --deep --strict "$APP" 2>/dev/null`)}` };
    case "archive": {
      const archive = `${macPath(host, `releases/${id}`)}/App.xcarchive`;
      return { ...base, needsApiKey: gate.useApiKey, releaseId: id, preScript: `mkdir -p ${macPath(host, `releases/${id}`)}`, steps: [...generate, { command: cmd.archiveCommand(container!, scheme, archive, paths.cache, signing) }],
        verify: `${succeeded("ARCHIVE")}\nPL=${archive}/Info.plist\n${mark("ARCHIVE", `[ -f "$PL" ] && [ -n "$(ls -d ${archive}/Products/Applications/*.app 2>/dev/null | head -1)" ]`)}\nfor K in CFBundleIdentifier CFBundleShortVersionString CFBundleVersion; do V=$(/usr/libexec/PlistBuddy -c "Print :ApplicationProperties:$K" "$PL" 2>/dev/null); printf '@@${nonce}:%s=%s\\n' "$K" "$V"; done`,};
    }
    case "export": {
      const archiveId = deps.state.lastArchive!.id;
      const archive = `${macPath(host, `releases/${archiveId}`)}/App.xcarchive`;
      const exportDir = `${macPath(host, `releases/${archiveId}`)}/export`;
      const plist = `${macPath(host, `releases/${archiveId}`)}/ExportOptions.plist`;
      const teamId = deps.settings.teamId ?? discovery.appTarget?.developmentTeam;
      if (teamId && !/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("Invalid Team ID.");
      return { needsSource: false, usesProjectSecrets: false, needsApiKey: gate.useApiKey, releaseId: archiveId,
        steps: [{ before: `cat > ${plist} <<'EXPORT_OPTIONS_PLIST'\n${cmd.exportOptionsPlist(teamId)}EXPORT_OPTIONS_PLIST\nrm -rf ${exportDir}`, command: cmd.exportCommand(archive, exportDir, plist, signing) }],
        verify: `${succeeded("EXPORT")}\nIPA=$(ls ${exportDir}/*.ipa 2>/dev/null | head -1)\n${mark("IPA", `[ -n "$IPA" ] && [ -s "$IPA" ] && unzip -l "$IPA" 2>/dev/null | grep -q 'Payload/.*\\.app/'`, '"${IPA#"$HOME"/}"')}` };
    }
    case "upload": {
      const exportInfo = deps.state.lastExport!;
      const ipa = homePath(exportInfo.ipaPath);
      return { needsSource: false, usesProjectSecrets: false, needsApiKey: true, steps: [{ command: cmd.uploadCommand(ipa, request.validateOnly) }],
        verify: `${mark("UPLOAD_OK", `grep -Eq 'UPLOAD SUCCEEDED|No errors uploading|No errors validating|Validation succeeded' "$output"`)}\nD=$(grep -Eo 'Delivery UUID: [0-9a-fA-F-]+' "$output" | head -1 | awk '{print $3}')\n[ -n "$D" ] && printf '@@${nonce}:DELIVERY=%s\\n' "$D"` };
    }
    case "install-device": {
      const bundleId = discovery.appTarget?.bundleId;
      if (!bundleId) throw new Error("No bundle identifier is known for the app target.");
      return { ...base, needsApiKey: gate.useApiKey, steps: [...generate, { command: cmd.deviceBuild(container!, scheme, deviceUdid ?? DEVICE_PLACEHOLDER, paths.cache, signing) }, { before: `APP_PATH=$(find ${built("Debug-iphoneos")} -maxdepth 1 -name '*.app' 2>/dev/null | head -1)`, command: cmd.deviceInstall(deviceUdid ?? DEVICE_PLACEHOLDER, '"$APP_PATH"') }, { command: cmd.deviceLaunch(deviceUdid ?? DEVICE_PLACEHOLDER, bundleId) }],
        verify: `${succeeded("BUILD")}\n${mark("INSTALLED", `grep -q 'App installed' "$output"`)}\n${mark("LAUNCHED", `grep -q 'Launched application' "$output"`)}` };
    }
  }
}

const SIM_PLACEHOLDER = "platform=iOS Simulator,id=<available iPhone simulator>";
const DEVICE_PLACEHOLDER = "00000000-0000000000000000";

function renderStep(step: Step): string {
  const rendered = cmd.renderCommand(step.command);
  // Not indented: the export step carries a heredoc whose terminator must start the line.
  const before = step.before ? `${step.before}\n` : "";
  return `if [ "$code" -eq 0 ]; then\n${before}  printf '\\n$ %s\\n' ${quote(step.command.label)} >>"$output"\n  ${rendered} >>"$output" 2>&1 </dev/null; code=$?\nfi`;
}

function buildScript(plan: Plan, deps: Pick<OperationDeps, "host" | "project" | "settings">, id: string, nonce: string): { script: string; redactVars: string[] } {
  const paths = remotePaths(deps.host, id);
  const secretEntries = plan.usesProjectSecrets ? Object.entries(deps.project.secrets) : [];
  const redactVars = secretEntries.map(([variable]) => variable);
  const exportsScript = secretEntries.map(([variable, name]) => `export ${variable}="$(${keychainSecretLookup(name)})" || { printf '%s\\n' ${quote(`Mac Build Keychain secret '${name}' is unavailable.`)} >&2; exit 23; }`).join("\n");
  let apiKeyScript = "";
  if (plan.needsApiKey && deps.settings.apiKey) {
    const key = deps.settings.apiKey;
    redactVars.push("ASC_KEY_ID", "ASC_ISSUER_ID");
    const missing = (name: string) => `{ printf '%s\\n' ${quote(`Mac Build Keychain secret '${name}' is unavailable.`)} >&2; exit 23; }`;
    apiKeyScript = `export ASC_KEY_ID="$(${keychainSecretLookup(key.keyIdSecret)})" || ${missing(key.keyIdSecret)}
export ASC_ISSUER_ID="$(${keychainSecretLookup(key.issuerIdSecret)})" || ${missing(key.issuerIdSecret)}
KEYDIR=${paths.job}/private_keys
mkdir -p "$KEYDIR" && chmod 700 "$KEYDIR"
trap 'rm -rf "$KEYDIR" "$output"' EXIT
${keychainSecretLookup(key.privateKeySecret)} | /usr/bin/base64 -D > "$KEYDIR/AuthKey_$ASC_KEY_ID.p8" || ${missing(key.privateKeySecret)}
chmod 600 "$KEYDIR/AuthKey_$ASC_KEY_ID.p8"
export ASC_KEY_PATH="$KEYDIR/AuthKey_$ASC_KEY_ID.p8"
export API_PRIVATE_KEYS_DIR="$KEYDIR"`;
  }
  const signedOp = plan.steps.some((step) => step.command.argv.some((arg) => typeof arg === "object" && "shell" in arg && arg.shell.includes("AGENT_TEAM_MAC_KEYCHAIN_PATH")));
  const keychainSearch = signedOp ? `/usr/bin/security list-keychains -d user -s "$AGENT_TEAM_MAC_KEYCHAIN_PATH" $(/usr/bin/security list-keychains -d user | /usr/bin/tr -d '"') >/dev/null 2>&1 || true` : "";
  const setup = plan.needsSource && deps.project.setupCommand ? `if [ "$code" -eq 0 ]; then printf '\\n$ repository preparation\\n' >>"$output"; ( cd ${paths.source} && ${deps.project.setupCommand} ) >>"$output" 2>&1 </dev/null; code=$?; fi` : "";
  const steps = plan.steps.map(renderStep).join("\n");
  const script = `${buildKeychainShell()}
set -o pipefail
${exportsScript}
output=$(mktemp)
trap 'rm -rf "$output"' EXIT
${apiKeyScript}
${keychainSearch}
${plan.needsSource ? `cd ${paths.source}` : `mkdir -p ${paths.job}`}
set +e
code=0
${plan.preScript ?? ""}
${setup}
${steps}
set -e
${keychainRedactionPipeline(redactVars)}
printf '\\n@@${nonce}:EXIT=%s\\n' "$code"
set +e
if [ "$code" -eq 0 ]; then
${plan.verify}
fi
exit 0
`;
  return { script, redactVars };
}

function parseMarkers(output: string, nonce: string): { markers: Record<string, string>; text: string } {
  const markers: Record<string, string> = {};
  const lines: string[] = [];
  const prefix = `@@${nonce}:`;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith(prefix)) { const rest = line.slice(prefix.length); const at = rest.indexOf("="); if (at > 0) markers[rest.slice(0, at)] = rest.slice(at + 1).trim(); }
    else lines.push(line);
  }
  return { markers, text: lines.join("\n") };
}

function displayFor(plan: Plan, deps: Pick<OperationDeps, "project" | "host">): string[] {
  const lines = plan.steps.map((step) => cmd.displayCommand(step.command).replace(SIM_PLACEHOLDER, "<available iPhone simulator>").replace(DEVICE_PLACEHOLDER, "<device udid>"));
  if (plan.needsSource && deps.project.setupCommand) lines.unshift(deps.project.setupCommand);
  return lines;
}

async function persistResult(request: OperationRequest, discovery: IosDiscovery, deps: OperationDeps, result: OperationResult, id: string, context: RunContext, markers: Record<string, string>): Promise<void> {
  if (deps.persist === false || request.dryRun) return;
  const folder = await saveOperationRecord(deps.repo, `${new Date().toISOString().replace(/[:.]/g, "-")}-${request.operation}-${id.slice(0, 8)}`, result);
  result.outputs = { ...result.outputs, artifacts: [...(result.outputs?.artifacts ?? []), path.join(folder, "result.json")] };
  const stepFor: Partial<Record<OperationName, import("./types.js").StepId>> = { "generate-project": "generate-project", "build-simulator": "build-simulator", "test-simulator": "test-simulator", "build-release": "build-release", "install-device": "install-device", archive: "archive", export: "export", upload: "upload" };
  const step = stepFor[request.operation];
  const at = new Date().toISOString();
  if (step) await recordStep(deps.repo, {
    step, at, summary: result.summary, treeHash: context.treeHash, ...(request.operation === "test-simulator" ? { scope: request.captureScreenshots ? "ui" : request.testScope ?? "all" } : {}),
    status: result.status === "success" ? "passed" : result.status === "blocked" ? "blocked" : "failed",
    ...(result.status === "success" ? {} : { blockers: [{ id: blockerId(result), remedy: result.remedy ?? "", kind: result.failureClass === "compile-error" || result.failureClass === "test-failure" ? "code" as const : result.failureClass === "permission-denied" || result.failureClass === "account-team" || result.failureClass === "credentials-missing" || result.failureClass === "duplicate-build" ? "user-input" as const : "environment" as const }] }),
  });
  if (result.status !== "success") return;
  await updateIosState(deps.repo, (state) => {
    if (request.operation === "archive" && result.outputs?.archivePath) state.lastArchive = { archivePath: result.outputs.archivePath, treeHash: context.treeHash, at, id };
    if (request.operation === "export" && result.outputs?.ipaPath && state.lastArchive) state.lastExport = { ipaPath: result.outputs.ipaPath, exportPath: result.outputs.exportPath ?? "", treeHash: context.treeHash, at, id: state.lastArchive.id };
    if (request.operation === "upload" && !request.validateOnly) state.lastUpload = { marketingVersion: discovery.appTarget?.marketingVersion, buildNumber: discovery.appTarget?.buildNumber, uploadId: result.outputs?.uploadId, at };
  });
}

/** Stable id a later resume check can test: the permission, secret or finding that must change. */
export function blockerId(result: OperationResult): string {
  switch (result.failureClass) {
    case "permission-denied": return /upload/i.test(result.summary) ? "permission-upload" : "permission-signing";
    case "account-team": return "team-id";
    case "credentials-missing": return "asc-api-key";
    case "duplicate-build": return "build-number";
    case "signing-identity": return "signing-distribution";
    case "provisioning": return "provisioning";
    case "xcode-version": return "xcode-version";
    case "missing-tool": return "tooling";
    case "environment": return /host/i.test(result.summary) ? "host" : "environment";
    default: return result.failureClass ?? "unknown";
  }
}

export async function runIosOperation(root: string, discovery: IosDiscovery, request: OperationRequest, deps: OperationDeps): Promise<OperationResult> {
  const started = Date.now();
  const context = await captureRunContext(root);
  const id = (deps.newId ?? (() => randomUUID().replaceAll("-", "")))();
  const nonce = (deps.newNonce ?? (() => randomUUID().replaceAll("-", "")))();
  const finish = async (result: OperationResult, markers: Record<string, string> = {}): Promise<OperationResult> => {
    result.context = context; result.durationMs = Date.now() - started;
    if (result.output) result.output = redactSecrets(result.output).slice(-OUTPUT_LIMIT);
    await persistResult(request, discovery, deps, result, id, context, markers);
    return result;
  };
  const gate = gateOperation(request, discovery, deps, context);
  const op = request.operation;
  if (gate.blocked) return finish({ operation: op, status: "blocked", verified: false, summary: gate.blocked.summary, failureClass: gate.blocked.failureClass, remedy: gate.blocked.remedy, commands: [] });

  let deviceUdid: string | undefined, simulatorDestination: string | undefined;
  const run = deps.run ?? sshScript;
  if (op === "test-simulator" && !request.dryRun) {
    const devices = await run(deps.host, "xcrun simctl list devices available --json\n", 30_000, 4_000_000);
    simulatorDestination = devices.code === 0 ? cmd.pickSimulator(devices.output, request.simulator) : undefined;
    if (!simulatorDestination) return finish({ operation: op, status: "blocked", verified: false, summary: request.simulator ? `No available simulator named "${request.simulator}" was found on ${deps.host.target}.` : `No available iOS simulator was found on ${deps.host.target}.`, failureClass: "environment", remedy: "Install an iOS simulator runtime: Xcode → Settings → Components.", commands: [] });
  }
  if (op === "install-device") {
    if (request.dryRun) deviceUdid = undefined;
    else {
      const probe = await run(deps.host, readinessProbeScript(), 45_000, 200_000);
      const picked = cmd.pickDevice(parseReadinessProbe(probe.output).devices, deps.settings.deviceUdid);
      if (!picked.device) return finish({ operation: op, status: "blocked", verified: false, summary: picked.reason ?? "No device available.", failureClass: "environment", remedy: "Connect and trust an iPhone (USB, Developer Mode on), or save its UDID in iOS release settings. On-device testing needs a physical iPhone.", commands: [] });
      deviceUdid = picked.device.udid;
    }
  }
  let plan: Plan;
  try { plan = planFor(request, discovery, gate, deps, id, nonce, { deviceUdid, simulatorDestination }); }
  catch (error) { return finish({ operation: op, status: "blocked", verified: false, summary: error instanceof Error ? error.message : String(error), failureClass: "environment", remedy: "Fix the project configuration and re-run discovery.", commands: [] }); }
  const commands = displayFor(plan, deps);
  if (request.dryRun) return finish({ operation: op, status: "dry-run", verified: false, summary: `Dry run: ${commands.length} command(s) would run on ${deps.host.target}. Nothing was signed, archived, uploaded, uploaded to the Mac, or changed.`, commands });

  const paths = remotePaths(deps.host, id);
  const { script } = buildScript(plan, deps, id, nonce);
  try {
    const init = await run(deps.host, `set -e\nmkdir -p ${paths.job} ${paths.cache}${plan.needsSource ? ` ${paths.source}` : ""}\n`);
    if (init.code !== 0) return finish(failedFrom(op, commands, init.output, init.code));
    if (plan.needsSource) await (deps.uploadSource ?? upload)(root, deps.host, paths.source);
    const timeout = Math.max(...plan.steps.map((step) => step.command.timeoutMs)) + 120_000;
    const execution = await run(deps.host, script, timeout, 600_000);
    const { markers, text } = parseMarkers(execution.output, nonce);
    const output = redactSecrets(text);
    const exitCode = markers.EXIT !== undefined ? Number(markers.EXIT) : execution.code === 0 ? NaN : execution.code;
    // Without a completion marker we cannot tell what happened, so show the raw end of the output (redacted) to diagnose it.
    if (!Number.isFinite(exitCode)) return finish({ ...failedFrom(op, commands, `${output}\n--- raw end of remote output (exit ${execution.code}) ---\n` + redactSecrets(execution.output.slice(-1500)), execution.code), failureClass: "verification", summary: `${op} produced no completion marker, so it is not counted as successful.`, remedy: cmd.remedyFor("verification") });
    if (exitCode !== 0) {
      const failure = failedFrom(op, commands, output, exitCode);
      if (op === "test-simulator" && exitCode !== 255 && ![20, 21, 22, 23].includes(exitCode)) {
        const { result, parsed, artifacts } = await collectTestEvidence(deps, paths, id, run);
        if (parsed?.failed) return finish({ ...failure, failureClass: "test-failure", remedy: cmd.remedyFor("test-failure"), summary: `${parsed.failed} of ${parsed.total} tests failed.`, testSummary: parsed, outputs: { artifacts } });
      }
      return finish(failure);
    }
    return finish(await verified(op, discovery, request, plan, markers, output, commands, paths, id, deps, run, root), markers);
  } catch (error) {
    return finish(failedFrom(op, commands, error instanceof Error ? error.message : String(error), -1));
  } finally {
    await run(deps.host, `rm -rf ${paths.job}\n`).catch(() => undefined);
  }
}

function failedFrom(operation: OperationName, commands: string[], output: string, code: number): OperationResult {
  if (code === 255) return { operation, status: "failed", verified: false, failureClass: "environment", summary: `${operation} failed: the SSH connection to the Mac failed.`, remedy: "Run the Mac readiness check; confirm the Mac is awake, reachable and the SSH alias works non-interactively.", commands, output };
  if ([20, 21, 22].includes(code)) return { operation, status: "failed", verified: false, failureClass: "environment", summary: `${operation} failed: the Agent Team Build Keychain is not usable.`, remedy: "Initialize/unlock the build Keychain and set AGENT_TEAM_MAC_KEYCHAIN_PASSWORD in ~/.agent-team/mac-build-host.env on the Mac.", commands, output };
  const classified = cmd.classifyFailure(code === 23 ? `${output}\nexit code 23` : output, operation);
  const first = output.split(/\r?\n/).filter((line) => /error|fail|denied|unavailable|not found/i.test(line)).slice(-3).join(" | ");
  return { operation, status: "failed", verified: false, failureClass: classified.failureClass, remedy: classified.remedy, summary: `${operation} failed (${classified.failureClass}${first ? `: ${first.slice(0, 300)}` : ""}).`, commands, output };
}

async function verified(op: OperationName, discovery: IosDiscovery, request: OperationRequest, plan: Plan, markers: Record<string, string>, output: string, commands: string[], paths: ReturnType<typeof remotePaths>, id: string, deps: OperationDeps, run: RemoteScriptRunner, root: string): Promise<OperationResult> {
  const unverified = (what: string): OperationResult => ({ operation: op, status: "failed", verified: false, failureClass: "verification", summary: `${op} exited 0 but ${what}; it is not counted as successful.`, remedy: cmd.remedyFor("verification"), commands, output });
  const ok = (summary: string, extra: Partial<OperationResult> = {}): OperationResult => ({ operation: op, status: "success", verified: true, summary, commands, output, ...extra });
  const target = discovery.appTarget;
  switch (op) {
    case "generate-project": return markers.PROJECT ? ok("XcodeGen produced the project file.") : unverified("the generated .xcodeproj was not found");
    case "build-simulator": return markers.SUCCEEDED && markers.APP ? ok("Simulator build succeeded and produced an .app.") : unverified("no BUILD SUCCEEDED line or no .app product was found");
    case "build-release": return markers.SUCCEEDED && markers.CODESIGN ? ok("Signed Release build succeeded and the app passes codesign verification.") : unverified("the build was not confirmed or the app failed codesign verification");
    case "test-simulator": {
      const { result, parsed, artifacts } = await collectTestEvidence(deps, paths, id, run);
      if (!markers.SUCCEEDED || !markers.XCRESULT) return unverified("no TEST SUCCEEDED line or result bundle was found");
      if (!parsed || !parsed.total) return unverified("the XCTest summary could not be read or reported zero tests");
      if (parsed.failed) return { operation: op, status: "failed", verified: true, failureClass: "test-failure", remedy: cmd.remedyFor("test-failure"), summary: `${parsed.failed} of ${parsed.total} tests failed.`, commands, output, testSummary: parsed, outputs: { artifacts } };
      return ok(`${parsed.passed ?? parsed.total} of ${parsed.total} tests passed on the simulator.`, { testSummary: parsed, outputs: { artifacts } });
    }
    case "archive": {
      const archivePath = `${deps.host.root}/releases/${id}/App.xcarchive`;
      if (!markers.SUCCEEDED || !markers.ARCHIVE) return unverified("the .xcarchive or its app product was not found");
      const mismatches: string[] = [];
      if (target?.bundleId && markers.CFBundleIdentifier !== target.bundleId) mismatches.push(`bundle id ${markers.CFBundleIdentifier || "(none)"} ≠ ${target.bundleId}`);
      if (target?.buildNumber && markers.CFBundleVersion !== target.buildNumber) mismatches.push(`build ${markers.CFBundleVersion || "(none)"} ≠ ${target.buildNumber}`);
      if (target?.marketingVersion && markers.CFBundleShortVersionString !== target.marketingVersion) mismatches.push(`version ${markers.CFBundleShortVersionString || "(none)"} ≠ ${target.marketingVersion}`);
      if (mismatches.length) return unverified(`the archive metadata disagrees with the project (${mismatches.join("; ")})`);
      return ok(`Archive verified: ${markers.CFBundleIdentifier} ${markers.CFBundleShortVersionString} (${markers.CFBundleVersion}).`, { outputs: { archivePath } });
    }
    case "export": {
      if (!markers.SUCCEEDED || !markers.IPA) return unverified("no non-empty .ipa with an app payload was found");
      const ipaPath = markers.IPA;
      return ok("Export verified: a non-empty .ipa with an app payload exists.", { outputs: { ipaPath, exportPath: path.posix.dirname(ipaPath) } });
    }
    case "upload": {
      if (!markers.UPLOAD_OK) return unverified("Apple's tool did not report a successful upload/validation");
      return ok(request.validateOnly ? "Apple's tool validated the package with no errors. Nothing was uploaded." : `Upload verified: Apple's tool reported success${markers.DELIVERY ? ` (delivery ${markers.DELIVERY})` : " (no delivery id was printed)"}. Processing state cannot be queried by this tool; check App Store Connect → TestFlight. The app has NOT been submitted for review.`, { outputs: { uploadId: markers.DELIVERY } });
    }
    case "install-device": return markers.SUCCEEDED && markers.INSTALLED && markers.LAUNCHED ? ok("Built, installed and launched on the physical device (devicectl confirmed).") : unverified("devicectl did not confirm both install and launch");
  }
}

async function collectTestEvidence(deps: OperationDeps, paths: ReturnType<typeof remotePaths>, id: string, run: RemoteScriptRunner): Promise<{ result: string; parsed: ReturnType<typeof parseTestSummary>; artifacts: string[] }> {
  const result = `${paths.job}/result.xcresult`;
  const summary = await run(deps.host, `xcrun xcresulttool get test-results summary --path ${result} --compact 2>/dev/null || true
`, 60_000, 200_000);
  const artifacts: string[] = [];
  if (deps.persist !== false) {
    const folder = path.join(runsDir(deps.repo), "artifacts", id);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "summary.json"), summary.output, "utf8").catch(() => undefined);
    artifacts.push(path.join(folder, "summary.json"));
    await run(deps.host, `rm -rf ${paths.job}/attachments; mkdir -p ${paths.job}/attachments; xcrun xcresulttool export attachments --path ${result} --output-path ${paths.job}/attachments >/dev/null 2>&1 || true
`);
    await (deps.downloadAttachments ?? downloadAttachments)(deps.host, `${paths.job}/attachments`, path.join(folder, "attachments"), { includeManifest: true, maxBytes: 60 * 1024 * 1024 });
    artifacts.push(...(await collectFiles(path.join(folder, "attachments"))).slice(0, 20));
  }
  return { result, parsed: parseTestSummary(summary.output), artifacts };
}

export function parseTestSummary(text: string): { passed?: number; failed?: number; skipped?: number; total?: number; raw?: string } | undefined {
  try {
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>;
    const num = (key: string) => typeof json[key] === "number" ? json[key] as number : undefined;
    const passed = num("passedTests"), failed = num("failedTests"), skipped = num("skippedTests");
    const total = num("totalTestCount") ?? (passed !== undefined && failed !== undefined ? passed + failed + (skipped ?? 0) : undefined);
    return total === undefined ? undefined : { passed, failed, skipped, total, raw: text.slice(0, 20_000) };
  } catch { return undefined; }
}
