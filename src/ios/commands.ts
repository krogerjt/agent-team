import { selectSimulatorDestination } from "../coding/apple.js";
import { quote } from "../remote/executor.js";
import type { FailureClass, OperationName } from "./types.js";

/** A literal argument (always shell-quoted), a reference to an environment variable resolved on the Mac, or a trusted internal fragment. */
export type Arg = string | { env: string } | { shell: string; display: string };

/** `env` entries are constant, internally chosen NAME=value pairs (never secrets) placed before the executable. */
export interface RemoteCommand { label: string; argv: Arg[]; timeoutMs: number; env?: Record<string, string> }

export function renderArg(arg: Arg): string { return typeof arg === "string" ? quote(arg) : "env" in arg ? `"$${arg.env}"` : arg.shell; }
function envPrefix(command: RemoteCommand): string {
  const entries = Object.entries(command.env ?? {});
  for (const [name, value] of entries) if (!/^[A-Z][A-Z0-9_]{0,60}$/.test(name) || !/^[A-Za-z0-9_.-]{0,60}$/.test(value)) throw new Error(`Invalid command environment: ${name}`);
  return entries.length ? `env ${entries.map(([name, value]) => `${name}=${value}`).join(" ")} ` : "";
}
export function renderCommand(command: RemoteCommand): string { return envPrefix(command) + command.argv.map(renderArg).join(" "); }
/** Human display: environment references are shown by name, never by value. */
export function displayCommand(command: RemoteCommand): string {
  return envPrefix(command) + command.argv.map((arg) => typeof arg === "string" ? (/^[\w@%+=:,./-]+$/.test(arg) ? arg : quote(arg)) : "env" in arg ? `$${arg.env}` : arg.display).join(" ");
}

const SAFE_NAME = /^[A-Za-z0-9_. -]{1,100}$/;
const SAFE_PATH = /^[A-Za-z0-9_./ -]{1,300}$/;
function requireSafe(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value) || value.includes("..") || value.startsWith("-")) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}

export interface Container { flag: "-workspace" | "-project"; file: string }
export interface ApiKeyEnv { keyId: string; issuerId: string; keyPath: string }
/** Names of Mac-side environment variables the runner exports from the build Keychain. */
export const ASC_ENV = { keyId: "ASC_KEY_ID", issuerId: "ASC_ISSUER_ID", keyPath: "ASC_KEY_PATH" } as const;

function base(container: Container, scheme: string): Arg[] {
  return [container.flag, requireSafe(container.file, SAFE_PATH, "project path"), "-scheme", requireSafe(scheme, SAFE_NAME, "scheme")];
}
function authFlags(useApiKey: boolean): Arg[] {
  return useApiKey ? ["-allowProvisioningUpdates", "-authenticationKeyPath", { env: ASC_ENV.keyPath }, "-authenticationKeyID", { env: ASC_ENV.keyId }, "-authenticationKeyIssuerID", { env: ASC_ENV.issuerId }] : [];
}
const keychainFlag: Arg = { shell: `"OTHER_CODE_SIGN_FLAGS=--keychain $AGENT_TEAM_MAC_KEYCHAIN_PATH"`, display: "OTHER_CODE_SIGN_FLAGS=--keychain <build keychain>" };
const derivedData = (cache: string): Arg[] => ["-derivedDataPath", { shell: `${cache}/DerivedData`, display: "<cache>/DerivedData" }];

export function xcodegenGenerate(spec: string): RemoteCommand {
  return { label: "XcodeGen project generation", argv: ["xcodegen", "generate", "--spec", requireSafe(spec, SAFE_PATH, "spec path")], timeoutMs: 180_000 };
}

export function simulatorBuild(container: Container, scheme: string, cache: string): RemoteCommand {
  return { label: `xcodebuild ${scheme} (iOS Simulator, unsigned)`, argv: ["xcodebuild", ...base(container, scheme), "-configuration", "Debug", "-destination", "generic/platform=iOS Simulator", ...derivedData(cache), "build", "CODE_SIGNING_ALLOWED=NO"], timeoutMs: 900_000 };
}

export function simulatorTest(container: Container, scheme: string, destination: string, resultBundle: string, cache: string, onlyTesting: string[] = [], captureScreenshots = false): RemoteCommand {
  // xcodebuild forwards TEST_RUNNER_-prefixed variables to the test process with the prefix removed.
  return { ...(captureScreenshots ? { env: { TEST_RUNNER_CAPTURE_SCREENSHOTS: "1" } } : {}), label: `xcodebuild ${scheme} tests (iOS Simulator)`, argv: ["xcodebuild", ...base(container, scheme), "-destination", destination, ...derivedData(cache), "-resultBundlePath", { shell: resultBundle, display: "<job>/result.xcresult" }, "-enableCodeCoverage", "YES", ...onlyTesting.map((name) => `-only-testing:${requireSafe(name, SAFE_NAME, "test target")}`), "test", "CODE_SIGNING_ALLOWED=NO"], timeoutMs: 1_800_000 };
}

export interface SigningOptions { teamId?: string; useApiKey: boolean }

export function releaseBuild(container: Container, scheme: string, cache: string, signing: SigningOptions): RemoteCommand {
  return { label: `xcodebuild ${scheme} (Release, signed)`, argv: ["xcodebuild", ...base(container, scheme), "-configuration", "Release", "-destination", "generic/platform=iOS", ...derivedData(cache), ...authFlags(signing.useApiKey), ...(signing.teamId ? [`DEVELOPMENT_TEAM=${signing.teamId}`] : []), keychainFlag, "build"], timeoutMs: 1_800_000 };
}

export function archiveCommand(container: Container, scheme: string, archivePath: string, cache: string, signing: SigningOptions): RemoteCommand {
  return { label: `xcodebuild archive ${scheme}`, argv: ["xcodebuild", ...base(container, scheme), "-configuration", "Release", "-destination", "generic/platform=iOS", "-archivePath", { shell: archivePath, display: "<releases>/<id>/App.xcarchive" }, ...derivedData(cache), ...authFlags(signing.useApiKey), ...(signing.teamId ? [`DEVELOPMENT_TEAM=${signing.teamId}`] : []), keychainFlag, "archive"], timeoutMs: 2_400_000 };
}

export function exportOptionsPlist(teamId: string | undefined): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
${teamId ? `  <key>teamID</key><string>${teamId}</string>\n` : ""}</dict>
</plist>
`;
}

export function exportCommand(archivePath: string, exportPath: string, plistPath: string, signing: SigningOptions): RemoteCommand {
  return { label: "xcodebuild -exportArchive (app-store-connect, export only)", argv: ["xcodebuild", "-exportArchive", "-archivePath", { shell: archivePath, display: "<archive>" }, "-exportPath", { shell: exportPath, display: "<export>" }, "-exportOptionsPlist", { shell: plistPath, display: "<ExportOptions.plist>" }, ...authFlags(signing.useApiKey)], timeoutMs: 1_200_000 };
}

export function uploadCommand(ipaPath: string, validateOnly = false): RemoteCommand {
  return { label: validateOnly ? "xcrun altool --validate-app" : "xcrun altool --upload-app", argv: ["xcrun", "altool", validateOnly ? "--validate-app" : "--upload-app", "-f", { shell: ipaPath, display: "<ipa>" }, "-t", "ios", "--apiKey", { env: ASC_ENV.keyId }, "--apiIssuer", { env: ASC_ENV.issuerId }], timeoutMs: 1_800_000 };
}

export function deviceBuild(container: Container, scheme: string, udid: string, cache: string, signing: SigningOptions): RemoteCommand {
  return { label: `xcodebuild ${scheme} (Debug, device)`, argv: ["xcodebuild", ...base(container, scheme), "-configuration", "Debug", "-destination", `id=${requireSafe(udid, /^[0-9A-Fa-f-]{20,64}$/, "device UDID")}`, ...derivedData(cache), ...authFlags(signing.useApiKey), ...(signing.teamId ? [`DEVELOPMENT_TEAM=${signing.teamId}`] : []), keychainFlag, "build"], timeoutMs: 1_800_000 };
}
export function deviceInstall(udid: string, appPath: string): RemoteCommand {
  return { label: "xcrun devicectl device install app", argv: ["xcrun", "devicectl", "device", "install", "app", "--device", requireSafe(udid, /^[0-9A-Fa-f-]{20,64}$/, "device UDID"), { shell: appPath, display: "<built .app>" }], timeoutMs: 300_000 };
}
export function deviceLaunch(udid: string, bundleId: string): RemoteCommand {
  return { label: "xcrun devicectl device process launch", argv: ["xcrun", "devicectl", "device", "process", "launch", "--device", requireSafe(udid, /^[0-9A-Fa-f-]{20,64}$/, "device UDID"), requireSafe(bundleId, /^[A-Za-z0-9.-]{3,155}$/, "bundle identifier")], timeoutMs: 120_000 };
}

// ---------------------------------------------------------------------------------------------------------------
// Simulator and device selection
// ---------------------------------------------------------------------------------------------------------------

export function pickSimulator(devicesJson: string, name?: string): string | undefined {
  try {
    if (!name) return selectSimulatorDestination(devicesJson, "iOS");
    // A named device (for example the 6.9-inch iPhone used for App Store screenshots): newest runtime first, booted preferred.
    const parsed = JSON.parse(devicesJson) as { devices?: Record<string, Array<{ isAvailable?: boolean; name?: string; udid?: string; state?: string }>> };
    const matches = Object.entries(parsed.devices ?? {}).filter(([runtime]) => runtime.includes(".iOS-")).sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
      .flatMap(([, devices]) => devices).filter((device) => device.isAvailable !== false && device.udid && device.name === name);
    const chosen = matches.find((device) => device.state === "Booted") ?? matches[0];
    return chosen?.udid ? `platform=iOS Simulator,id=${chosen.udid}` : undefined;
  } catch { return undefined; }
}

export interface DeviceInfo { name: string; os: string; udid: string }
export function pickDevice(devices: DeviceInfo[], preferredUdid?: string): { device?: DeviceInfo; reason?: string } {
  if (!devices.length) return { reason: "No physical iPhone is visible to the Mac." };
  if (preferredUdid) {
    const match = devices.find((device) => device.udid.toLowerCase() === preferredUdid.toLowerCase());
    return match ? { device: match } : { reason: `The preferred device ${preferredUdid} is not connected. Connected: ${devices.map((d) => d.name).join(", ")}.` };
  }
  const iphones = devices.filter((device) => /iPhone/.test(device.name));
  const pool = iphones.length ? iphones : devices;
  if (pool.length > 1) return { reason: `Several devices are connected (${pool.map((d) => `${d.name} ${d.udid}`).join("; ")}). Save a preferred device UDID in iOS release settings.` };
  return { device: pool[0] };
}

// ---------------------------------------------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------------------------------------------

const RULES: Array<[RegExp, FailureClass]> = [
  [/Terminated \(SIG/i, "timeout"],
  [/database is locked|two concurrent builds/i, "build-cache-locked"],
  [/Testing cancelled because the build failed/i, "compile-error"],
  [/Mac Build Keychain secret '[^']+' is unavailable|exit code 23/i, "credentials-missing"],
  [/bundle version must be higher|redundant binary upload|ENTITY_ERROR\.ATTRIBUTE\.INVALID\.DUPLICATE|has already been used|build.*already exists/i, "duplicate-build"],
  [/Authentication failed|NOT_AUTHORIZED|Invalid API key|Unable to authenticate|invalid issuer|\b401\b.*(?:unauthor|auth)|Could not (?:read|find) (?:the )?(?:private key|AuthKey)/i, "authentication"],
  [/Team ".*" is not enrolled|not a member of (?:the )?team|No Accounts|no account for team|team ID .* not|You are not authorized|agreement.*(?:not signed|must be accepted)|Cannot determine .*team/i, "account-team"],
  [/No signing certificate|no identity found|Code Signing Error.*certificate|errSecInternalComponent|0 valid identities|certificate.*(?:not found|has expired|revoked)/i, "signing-identity"],
  [/No profiles for|provisioning profile|doesn't include (?:signing certificate|the)|requires a provisioning profile|Automatic signing (?:failed|cannot)/i, "provisioning"],
  [/requires Xcode|minimum.*Xcode|Xcode \d+(?:\.\d+)* or later|SDK .* (?:is not|isn't) (?:installed|available)/i, "xcode-version"],
  [/command not found|xcodegen: not found|No such file or directory.*(?:xcodegen|altool|xcodebuild)/i, "missing-tool"],
  [/Could not resolve host|Network is unreachable|Connection (?:reset|refused)|timed out|NSURLErrorDomain|-1009|offline/i, "network"],
  [/Test Case .* failed|Executed \d+ tests?, with [1-9]\d* failures?|\*\* TEST FAILED \*\*|Failing tests:/i, "test-failure"],
  [/error: |fatal error:|\*\* (?:BUILD|ARCHIVE) FAILED \*\*|Compile Swift Module .* failed/i, "compile-error"],
  [/Operation not permitted|Permission denied/i, "permission-denied"],
];

const REMEDIES: Record<FailureClass, string> = {
  environment: "Run the Mac readiness check and fix the failed items.",
  "xcode-version": "Install the required Xcode version on the Mac (Xcode 26 or later) and select it with xcode-select.",
  "missing-tool": "Install the missing tool on the Mac (for example brew install xcodegen) and make sure SSH sessions can see it.",
  "signing-identity": "Import an Apple Distribution certificate with its private key into the Agent Team Build Keychain on the Mac, and run set-key-partition-list so codesign can use it unattended.",
  provisioning: "Enable automatic signing with an App Store Connect API key, or install an App Store provisioning profile for this bundle ID on the Mac.",
  "account-team": "Check the Team ID and that the Apple Developer Program membership and agreements are active (App Store Connect → Business / Agreements).",
  "credentials-missing": "Store the missing secret by name in the Agent Team Build Keychain (Workshop Options → Mac Build Host → secrets) and map it in iOS release settings.",
  authentication: "The App Store Connect API key was rejected. Confirm the key ID, issuer ID and .p8 are correct, active, and have an App Manager or Admin role; re-save the secrets.",
  "compile-error": "Fix the compiler errors shown in the build output.",
  "build-cache-locked": "Another xcodebuild is using the shared build cache on the Mac. On the Mac run: pkill -f xcodebuild; pkill -f XCBBuildService; rm -rf ~/.agent-team-builder/cache/DerivedData, then retry. Do not run two builds against the same Mac at once.",
  "test-failure": "Fix the failing tests shown in the summary, then re-run.",
  "duplicate-build": "Increment the build number (CURRENT_PROJECT_VERSION) above every build already uploaded for this version, then archive again.",
  network: "The Mac could not reach Apple's services. Check its network connection and retry.",
  "permission-denied": "Grant the required permission (signing or upload) yourself with the CLI, or fix file permissions on the Mac.",
  verification: "The command finished but the expected output could not be verified, so it is NOT counted as successful. Inspect the output log.",
  timeout: "The operation hit its time limit. Retry; if it repeats, check Mac load and disk space.",
  unknown: "Read the redacted output below for the first error and address it.",
};

export function classifyFailure(output: string, _operation?: OperationName): { failureClass: FailureClass; remedy: string } {
  for (const [pattern, failureClass] of RULES) if (pattern.test(output)) return { failureClass, remedy: REMEDIES[failureClass] };
  return { failureClass: "unknown", remedy: REMEDIES.unknown };
}
export function remedyFor(failureClass: FailureClass): string { return REMEDIES[failureClass]; }
