import { readFile } from "node:fs/promises";
import path from "node:path";
import { listProjectFiles } from "./discovery.js";
import { countScreenshots, validateReleaseFiles } from "./prepare.js";
import { buildReport, type Report } from "./report.js";
import type { Finding, IosDiscovery } from "./types.js";

/** Facts the audit cannot learn from files alone. All come from recorded, verified operation results. */
export interface AuditEvidence {
  unitTests?: "passed" | "failed";
  uiTests?: "passed" | "failed";
  simulatorBuild?: "passed" | "failed";
  deviceTest?: "passed" | "failed";
  /** Highest build number recorded as successfully uploaded for the current marketing version. */
  lastUploadedBuild?: string;
  /** Build numbers known to exist in App Store Connect (only when it was actually queried). */
  knownRemoteBuilds?: string[];
  distributionIdentityAvailable?: boolean;
}

function finding(id: string, title: string, status: Finding["status"], detail: string, remedy?: string, needsUserInput?: boolean): Finding {
  return { id, title, status, detail, ...(remedy ? { remedy } : {}), ...(needsUserInput ? { needsUserInput } : {}) };
}

const PLACEHOLDER_BUNDLE = /^(com\.example|com\.yourcompany|com\.company|org\.example|com\.apple)\b/i;
const USAGE_KEYS: Record<string, string[]> = {
  camera: ["NSCameraUsageDescription"], microphone: ["NSMicrophoneUsageDescription"], photos: ["NSPhotoLibraryUsageDescription", "NSPhotoLibraryAddUsageDescription"],
  location: ["NSLocationWhenInUseUsageDescription", "NSLocationAlwaysAndWhenInUseUsageDescription"], contacts: ["NSContactsUsageDescription"],
  health: ["NSHealthShareUsageDescription", "NSHealthUpdateUsageDescription"], tracking: ["NSUserTrackingUsageDescription"],
};
const DEV_ENDPOINT = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.2\.2|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)|https?:\/\/[^\s"']*\.(?:ngrok(?:-free)?\.(?:io|app)|local)\b|https?:\/\/(?:dev|staging|stage|test|qa)[.-][^\s"']+)/i;

/** Remove `#if DEBUG … #endif` blocks (honouring `#else`) so debug-only code is not flagged. */
export function stripDebugBlocks(source: string): string {
  const out: string[] = [];
  const stack: Array<{ debug: boolean; inElse: boolean }> = [];
  const hidden = () => stack.some((entry) => entry.debug && !entry.inElse);
  for (const line of source.split(/\r?\n/)) {
    const t = line.trim();
    if (/^#if\b/.test(t)) { stack.push({ debug: /^#if\s+DEBUG\s*$/.test(t), inElse: false }); continue; }
    if (/^#else\b/.test(t) && stack.length) { stack[stack.length - 1].inElse = true; continue; }
    if (/^#elseif\b/.test(t) && stack.length) { continue; }
    if (/^#endif\b/.test(t)) { stack.pop(); continue; }
    if (!hidden()) out.push(line);
  }
  return out.join("\n");
}

async function scanDebugSettings(root: string, discovery: IosDiscovery, files: string[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  const read = (file: string) => readFile(path.join(root, file), "utf8").catch(() => "");
  const plists = files.filter((file) => /(^|\/)Info\.plist$/.test(file) && !/Tests?\//.test(file));
  const issues: string[] = [];
  for (const plist of plists) {
    const text = await read(plist);
    if (/<key>NSAllowsArbitraryLoads<\/key>\s*<true\/>/.test(text)) issues.push(`${plist}: App Transport Security allows arbitrary loads.`);
  }
  for (const entitlement of files.filter((file) => /\.entitlements$/.test(file))) {
    if (/<key>get-task-allow<\/key>\s*<true\/>/.test(await read(entitlement))) issues.push(`${entitlement}: get-task-allow is true, which is a debug-only entitlement.`);
  }
  const spec = discovery.xcodeGenSpec ? await read(discovery.xcodeGenSpec) : "";
  const pbx = (await Promise.all(files.filter((file) => /\.xcodeproj\/project\.pbxproj$/.test(file)).map(read))).join("\n");
  if (/NSAllowsArbitraryLoads\s*:\s*true/i.test(spec)) issues.push(`${discovery.xcodeGenSpec}: App Transport Security allows arbitrary loads.`);
  if (/INFOPLIST_KEY_NSAppTransportSecurity|NSAllowsArbitraryLoads\s*=\s*YES/.test(pbx)) issues.push("project.pbxproj: App Transport Security exception is configured.");
  const releaseBlock = /name = Release;[\s\S]{0,400}?SWIFT_OPTIMIZATION_LEVEL = "?-Onone/.test(pbx) || /Release:\s*\n(?:\s+.*\n){0,12}?\s+SWIFT_OPTIMIZATION_LEVEL:\s*"?-Onone/.test(spec);
  if (releaseBlock) issues.push("Release configuration uses -Onone (debug optimization).");
  const endpoints: string[] = [];
  for (const file of files.filter((candidate) => /\.(swift|m|mm|plist|json|xcconfig)$/.test(candidate) && !/(Tests?|UITests?|Preview|Mock|Fixtures?)\b/i.test(candidate) && !/^release\//.test(candidate))) {
    const text = await read(file);
    if (!text || text.length > 300_000) continue;
    const live = /\.(swift|m|mm)$/.test(file) ? stripDebugBlocks(text) : text;
    const match = DEV_ENDPOINT.exec(live.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n"));
    if (match) endpoints.push(`${file}: ${match[0].slice(0, 80)}`);
  }
  if (endpoints.length) issues.push(...endpoints.slice(0, 5).map((entry) => `Development endpoint outside #if DEBUG — ${entry}`));
  findings.push(issues.length
    ? finding("debug-settings", "Debug-only settings and development endpoints", "failed", issues.join(" | "), "Remove them, or guard them with #if DEBUG so Release builds never include them.")
    : finding("debug-settings", "Debug-only settings and development endpoints", "passed", "No ATS bypass, debug entitlement, -Onone Release setting or development endpoint found outside #if DEBUG."));
  return findings;
}

async function hasEncryptionDeclaration(root: string, discovery: IosDiscovery, files: string[]): Promise<boolean> {
  const sources = [...files.filter((file) => /(^|\/)Info\.plist$/.test(file) || /\.xcodeproj\/project\.pbxproj$/.test(file) || file === discovery.xcodeGenSpec)];
  for (const file of sources) if (/ITSAppUsesNonExemptEncryption/.test(await readFile(path.join(root, file), "utf8").catch(() => ""))) return true;
  return false;
}

/** Reusable release-readiness audit. Never reports `passed` for anything it could not verify from files or recorded evidence. */
export async function auditRelease(root: string, discovery: IosDiscovery, evidence: AuditEvidence = {}): Promise<Report<{ discovery: IosDiscovery["facts"] }>> {
  const data = { discovery: discovery.facts };
  if (discovery.blockers.length) return buildReport("iOS release audit", discovery.blockers, data);
  const files = await listProjectFiles(root);
  const t = discovery.appTarget!;
  const findings: Finding[] = [];

  const idOk = Boolean(t.bundleId) && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(t.bundleId!) && !PLACEHOLDER_BUNDLE.test(t.bundleId!);
  findings.push(!t.bundleId ? finding("bundle-id", "Bundle ID", "failed", "Not set.", "Set PRODUCT_BUNDLE_IDENTIFIER.", true)
    : idOk ? finding("bundle-id", "Bundle ID", "passed", t.bundleId)
    : finding("bundle-id", "Bundle ID", "failed", `'${t.bundleId}' is malformed or a placeholder/reserved prefix.`, "Use a reverse-DNS identifier you own that matches the App Store Connect app record.", true));

  const versionOk = /^\d+(\.\d+){0,2}$/.test(t.marketingVersion ?? "") && /^\d+(\.\d+){0,2}$/.test(t.buildNumber ?? "");
  findings.push(finding("version-metadata", "Version and build metadata", versionOk ? "passed" : "failed", `version ${t.marketingVersion ?? "(unset)"}, build ${t.buildNumber ?? "(unset)"}`, versionOk ? undefined : "Set MARKETING_VERSION like 1.0.0 and CURRENT_PROJECT_VERSION like 1."));

  const build = t.buildNumber;
  if (!build) findings.push(finding("build-number", "Build number uniqueness", "failed", "No build number.", "Set CURRENT_PROJECT_VERSION."));
  else if (evidence.knownRemoteBuilds?.includes(build)) findings.push(finding("build-number", "Build number uniqueness", "failed", `Build ${build} already exists in App Store Connect.`, "Increment the build number before uploading."));
  else if (evidence.lastUploadedBuild !== undefined && Number(build) <= Number(evidence.lastUploadedBuild)) findings.push(finding("build-number", "Build number uniqueness", "failed", `Build ${build} is not above the last uploaded build ${evidence.lastUploadedBuild}.`, "Increment the build number."));
  else findings.push(finding("build-number", "Build number uniqueness", "pending", `Build ${build} is unverified against App Store Connect${evidence.lastUploadedBuild ? ` (last upload recorded here: ${evidence.lastUploadedBuild})` : " (no upload recorded here)"}.`, "Increment the build number before every upload, or verify in App Store Connect."));

  const signingDetails = [`style ${t.codeSignStyle ?? "unspecified"}`, t.developmentTeam ? "team configured" : "no DEVELOPMENT_TEAM in project"].join(", ");
  if (evidence.distributionIdentityAvailable === false) findings.push(finding("release-signing", "Release signing", "blocked", `${signingDetails}; the Mac has no distribution identity.`, "Import an Apple Distribution certificate into the build Keychain, or use automatic signing with an App Store Connect API key."));
  else if (!t.developmentTeam) findings.push(finding("release-signing", "Release signing", "pending", `${signingDetails}.`, "Provide your Apple Developer Team ID (set DEVELOPMENT_TEAM, or supply it at archive time).", true));
  else findings.push(finding("release-signing", "Release signing", evidence.distributionIdentityAvailable ? "passed" : "pending", `${signingDetails}${evidence.distributionIdentityAvailable ? "; distribution identity present" : "; Mac signing readiness not checked"}.`, "Run the Mac readiness check."));

  findings.push(discovery.appIcon.hasMarketing1024 ? finding("app-icon", "App icon completeness", "passed", `${discovery.appIcon.catalog}/${discovery.appIcon.setName}.appiconset`) : finding("app-icon", "App icon completeness", "failed", discovery.appIcon.missing.join(" "), "Add an opaque 1024×1024 PNG to the AppIcon set."));

  findings.push(...await scanDebugSettings(root, discovery, files));

  const testsDefined = discovery.testTargets.unit.length + discovery.testTargets.ui.length;
  if (!testsDefined) findings.push(finding("tests", "Test coverage/status", "pending", "No unit or UI test targets were found.", "Add at least a unit test target so releases are verified."));
  else if (evidence.unitTests === "failed" || evidence.uiTests === "failed") findings.push(finding("tests", "Test coverage/status", "failed", "A recorded simulator test run failed.", "Fix the failing tests and re-run them on the simulator."));
  else if (evidence.unitTests === "passed" || evidence.uiTests === "passed") findings.push(finding("tests", "Test coverage/status", "passed", `Passed on simulator: ${[evidence.unitTests && "unit", evidence.uiTests && "UI"].filter(Boolean).join(", ")}. Targets: ${[...discovery.testTargets.unit, ...discovery.testTargets.ui].join(", ")}.`));
  else findings.push(finding("tests", "Test coverage/status", "pending", `${testsDefined} test target(s) exist but no verified simulator run is recorded for this tree.`, "Run the simulator tests."));
  findings.push(evidence.simulatorBuild === "passed" ? finding("simulator-build", "Simulator build", "passed", "Verified build recorded") : evidence.simulatorBuild === "failed" ? finding("simulator-build", "Simulator build", "failed", "Latest recorded build failed.", "Fix compile errors and rebuild.") : finding("simulator-build", "Simulator build", "pending", "No verified build recorded for this tree.", "Run the simulator build."));

  const missingUsage: string[] = [];
  for (const behavior of discovery.detectedBehaviors) {
    const keys = USAGE_KEYS[behavior];
    if (keys && !keys.some((key) => discovery.usageDescriptions.includes(key))) missingUsage.push(`${behavior} → ${keys[0]}`);
  }
  const needsManifest = discovery.requiredReasonApis || discovery.detectedBehaviors.some((behavior) => ["tracking", "analytics"].includes(behavior));
  const privacyIssues = [...missingUsage.map((entry) => `missing usage description (${entry})`), ...(needsManifest && !discovery.privacyManifest ? ["no PrivacyInfo.xcprivacy privacy manifest although the app uses required-reason APIs or tracking/analytics SDKs"] : [])];
  findings.push(privacyIssues.length ? finding("privacy-behavior", "Privacy-related behavior", "failed", privacyIssues.join("; "), "Add the purpose strings and a privacy manifest declaring the required-reason APIs and collected data.", true)
    : finding("privacy-behavior", "Privacy-related behavior", "passed", `Detected: ${discovery.detectedBehaviors.join(", ") || "no sensitive APIs"}; usage descriptions and manifest are consistent. Still answer App Privacy truthfully in App Store Connect.`));

  findings.push(...await validateReleaseFiles(root, discovery));

  const declared = await hasEncryptionDeclaration(root, discovery, files);
  findings.push(declared ? finding("encryption-key", "ITSAppUsesNonExemptEncryption declared", "passed", "Present in the project; uploads will not prompt for it.") : finding("encryption-key", "ITSAppUsesNonExemptEncryption declared", "pending", "Not declared; App Store Connect will ask on every build.", "Set ITSAppUsesNonExemptEncryption (YES/NO) in Info.plist once you have decided; the agent will not decide for you.", true));

  for (const shots of await countScreenshots(root, discovery)) {
    const need = shots.needed;
    if (need === false) continue;
    const id = `screenshots-${shots.cls.id}`;
    const title = `Screenshots — ${shots.cls.label}`;
    if (shots.valid >= shots.cls.min && !shots.invalid.length) findings.push(finding(id, title, "passed", `${shots.valid} valid screenshot(s)`));
    else if (shots.invalid.length) findings.push(finding(id, title, "failed", `Wrong size/format: ${shots.invalid.slice(0, 4).join(", ")}`, "Re-capture at an accepted size (opaque PNG).", false));
    else findings.push(finding(id, title, need === "unknown" ? "pending" : "pending", need === "unknown" ? "Unknown whether the app supports iPad; none provided." : "None provided.", `Capture and add to release/screenshots/${shots.cls.folder}/. See the screenshot guidance.`));
  }

  findings.push(evidence.deviceTest === "passed" ? finding("physical-device", "Physical-device testing", "passed", "A verified on-device install and launch is recorded for this tree.")
    : evidence.deviceTest === "failed" ? finding("physical-device", "Physical-device testing", "failed", "The latest on-device install/launch failed.", "Check signing, device trust and Developer Mode, then retry.")
    : finding("physical-device", "Physical-device testing", "pending", "No on-device run is recorded. This needs a physical iPhone.", "Connect an unlocked iPhone to the Mac and run the device install step, then test core flows by hand."));
  return buildReport("iOS release audit", findings, data);
}
