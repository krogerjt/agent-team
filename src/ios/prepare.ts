import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { listProjectFiles, pngInfo } from "./discovery.js";
import type { Finding, IosDiscovery } from "./types.js";

export const PLACEHOLDER_MARKER = "[[REQUIRES USER INPUT";
const PLACEHOLDER_PATTERN = /\[\[REQUIRES USER INPUT|\bTBD\b|\bTODO\b|lorem ipsum|REPLACE[_ ]ME|<your[- ][^>]*>|\bexample\.(?:com|org)\b/i;

export function hasPlaceholder(text: string): boolean { return PLACEHOLDER_PATTERN.test(text); }
export function userInput(what: string): string { return `${PLACEHOLDER_MARKER}: ${what}]]`; }

export interface FileChange { file: string; before: string; after: string }
export interface VersionBumpResult { applied: boolean; dryRun: boolean; changes: FileChange[]; marketingVersion?: { from?: string; to?: string }; buildNumber?: { from?: string; to?: string }; warnings: string[] }

export function nextBuildNumber(current: string): string {
  if (!/^\d+(\.\d+){0,2}$/.test(current)) throw new Error(`Build number '${current}' is not numeric, so it cannot be incremented automatically.`);
  const parts = current.split(".");
  parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
  return parts.join(".");
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function replaceSetting(text: string, key: string, from: string, to: string): string {
  const old = escapeRegex(from);
  return text
    .replace(new RegExp(`^(\\s*${key}\\s*:\\s*)(["']?)${old}\\2(\\s*(?:#.*)?)$`, "gm"), `$1$2${to}$2$3`)       // project.yml
    .replace(new RegExp(`(${key} = )"?${old}"?;`, "g"), `$1${to};`)                                         // project.pbxproj
    .replace(new RegExp(`(<key>${key === "CURRENT_PROJECT_VERSION" ? "CFBundleVersion" : "CFBundleShortVersionString"}</key>\\s*<string>)${old}(</string>)`, "g"), `$1${to}$2`); // Info.plist
}

/**
 * Increment the build number and/or set the marketing version. Edits only literal version values in the project
 * spec, pbxproj files and the app Info.plist, and only where they equal the discovered current value.
 * Defaults to a dry run; nothing is written unless `dryRun` is false.
 */
export async function bumpVersion(root: string, discovery: IosDiscovery, request: { incrementBuild?: boolean; setBuild?: string; marketingVersion?: string; dryRun?: boolean }): Promise<VersionBumpResult> {
  const dryRun = request.dryRun !== false;
  const target = discovery.appTarget;
  if (!target) throw new Error("No application target was discovered, so no version can be changed.");
  const warnings: string[] = [];
  const result: VersionBumpResult = { applied: false, dryRun, changes: [], warnings };
  const edits: Array<{ key: "CURRENT_PROJECT_VERSION" | "MARKETING_VERSION"; from: string; to: string }> = [];
  if (request.incrementBuild || request.setBuild) {
    if (!target.buildNumber) throw new Error("The build number is not set in the project, so it cannot be incremented. Set CURRENT_PROJECT_VERSION first.");
    const to = request.setBuild ?? nextBuildNumber(target.buildNumber);
    if (!/^\d+(\.\d+){0,2}$/.test(to)) throw new Error(`Invalid build number '${to}'. Use digits and dots, for example 12.`);
    result.buildNumber = { from: target.buildNumber, to };
    if (to !== target.buildNumber) edits.push({ key: "CURRENT_PROJECT_VERSION", from: target.buildNumber, to });
  }
  if (request.marketingVersion !== undefined) {
    if (!/^\d+(\.\d+){0,2}$/.test(request.marketingVersion)) throw new Error(`Invalid marketing version '${request.marketingVersion}'. Use 1.2 or 1.2.3.`);
    if (!target.marketingVersion) throw new Error("The marketing version is not set in the project; set MARKETING_VERSION first.");
    result.marketingVersion = { from: target.marketingVersion, to: request.marketingVersion };
    if (request.marketingVersion !== target.marketingVersion) {
      if (compareVersions(request.marketingVersion, target.marketingVersion) < 0) warnings.push(`Marketing version goes down from ${target.marketingVersion} to ${request.marketingVersion}; App Store Connect rejects versions lower than a released one.`);
      edits.push({ key: "MARKETING_VERSION", from: target.marketingVersion, to: request.marketingVersion });
    }
  }
  if (!edits.length) { warnings.push("Nothing to change."); return result; }
  const files = await listProjectFiles(root);
  const candidates = files.filter((file) => file === discovery.xcodeGenSpec || /\.xcodeproj\/project\.pbxproj$/.test(file) || (target.infoPlist && file === target.infoPlist.replace(/^\$\(SRCROOT\)\/?/, "")));
  for (const file of candidates) {
    const before = await readFile(path.join(root, file), "utf8");
    let after = before;
    for (const edit of edits) after = replaceSetting(after, edit.key, edit.from, edit.to);
    if (after !== before) { result.changes.push({ file, before, after }); }
  }
  for (const edit of edits) {
    const touched = result.changes.some((change) => replaceSetting(change.before, edit.key, edit.from, edit.to) !== change.before);
    if (!touched) throw new Error(`Could not find a literal ${edit.key} = ${edit.from} to update (it may come from an .xcconfig file). Update it by hand, then re-run discovery.`);
  }
  if (!dryRun) {
    for (const change of result.changes) await writeFile(path.join(root, change.file), change.after, "utf8");
    result.applied = true;
  }
  return result;
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Release metadata, privacy/support starters
// ---------------------------------------------------------------------------------------------------------------

export const RELEASE_DIR = "release";

export interface ScreenshotClass { id: string; label: string; folder: string; required: "always" | "if-ipad"; accepted: Array<{ width: number; height: number }>; min: number; max: number }

/** Sizes follow Apple's published App Store Connect guidance when written; always confirm in App Store Connect before submitting. */
export const SCREENSHOT_CLASSES: ScreenshotClass[] = [
  { id: "iphone-6.9", label: 'iPhone 6.9" display', folder: "iphone-6.9", required: "always", min: 1, max: 10, accepted: [{ width: 1320, height: 2868 }, { width: 1290, height: 2796 }, { width: 1260, height: 2736 }, { width: 2868, height: 1320 }, { width: 2796, height: 1290 }, { width: 2736, height: 1260 }] },
  { id: "ipad-13", label: 'iPad 13" display', folder: "ipad-13", required: "if-ipad", min: 1, max: 10, accepted: [{ width: 2064, height: 2752 }, { width: 2048, height: 2732 }, { width: 2752, height: 2064 }, { width: 2732, height: 2048 }] },
];

export function supportsIpad(discovery: IosDiscovery): boolean | undefined {
  const family = discovery.appTarget?.deviceFamily;
  return family === undefined ? undefined : family.split(",").map((part) => part.trim()).includes("2");
}

export function screenshotRequirements(discovery: IosDiscovery): { classes: Array<ScreenshotClass & { needed: boolean | "unknown" }>; guidance: string[] } {
  const ipad = supportsIpad(discovery);
  return {
    classes: SCREENSHOT_CLASSES.map((entry) => ({ ...entry, needed: entry.required === "always" ? true : ipad ?? "unknown" })),
    guidance: [
      `Put opaque PNG files under ${RELEASE_DIR}/screenshots/<folder>/ using the folder names above. They must have no alpha channel and match an accepted pixel size exactly.`,
      "iPhone 6.9\": boot an iPhone 17 Pro Max (or the largest available iPhone) simulator, run the app, and capture: xcrun simctl io booted screenshot iphone-1.png.",
      "iPad 13\": boot an iPad Pro 13-inch simulator and capture the same way. Only required if the app supports iPad (TARGETED_DEVICE_FAMILY includes 2).",
      "For repeatable shots, write a UI test that navigates to each key screen and attaches XCUIScreen.main.screenshot(); the host's test runner exports xcresult attachments as artifacts.",
      "Show real app content, not splash/login screens only. 1–10 screenshots per class. Do not include device frames unless you are comfortable maintaining them.",
      "Confirm current sizes in App Store Connect → App Information; Apple changes accepted sizes with new devices.",
    ],
  };
}

export function metadataTemplate(discovery: IosDiscovery): Record<string, unknown> {
  const target = discovery.appTarget;
  const behaviors = discovery.detectedBehaviors;
  return {
    templateVersion: 1,
    note: `Every ${PLACEHOLDER_MARKER}] value must be written by you. The agent never invents legal text, URLs, pricing, copyright owners or Apple account details.`,
    app: {
      name: userInput("App Store name, max 30 characters"),
      subtitle: userInput("subtitle, max 30 characters"),
      primaryCategory: userInput("App Store primary category"),
      bundleId: target?.bundleId ?? userInput("bundle identifier"),
      marketingVersion: target?.marketingVersion ?? userInput("marketing version"),
    },
    listing: {
      description: userInput("App Store description"),
      keywords: userInput("keywords, comma separated, max 100 characters"),
      promotionalText: userInput("promotional text (optional)"),
      whatsNew: userInput("release notes for this version"),
      copyright: userInput("copyright holder and year, for example '2026 Your Name or Company'"),
    },
    urls: {
      supportUrl: userInput("public support URL (https)"),
      privacyPolicyUrl: userInput("public privacy policy URL (https)"),
      marketingUrl: "",
    },
    pricing: { model: userInput("free, paid or in-app purchases; price tier is set in App Store Connect") },
    ageRating: { note: userInput("answer the age-rating questionnaire in App Store Connect and record the result") },
    review: {
      contact: { firstName: userInput("review contact first name"), lastName: userInput("last name"), email: userInput("email"), phone: userInput("phone") },
      demoAccount: { required: userInput("true or false"), username: "", password: "(never store here; enter in App Store Connect)" },
      notes: userInput("anything Apple's reviewer needs to use or test the app"),
    },
    exportCompliance: { usesNonExemptEncryption: userInput("true or false; see release/export-compliance.md") },
    privacyNutritionLabel: {
      status: "unconfirmed-suggestions",
      detectedBehaviors: behaviors,
      note: "Suggestions from source scanning only. You must answer App Privacy in App Store Connect truthfully, including third-party SDK data collection.",
    },
  };
}

const BEHAVIOR_SECTIONS: Record<string, string> = {
  network: "The app connects to network services. Describe which servers, what data is sent, and why.",
  location: "The app can access device location. Describe whether it is precise or approximate, when it is read, and whether it is stored or shared.",
  camera: "The app can access the camera. Describe what is captured and whether it leaves the device.",
  microphone: "The app can access the microphone. Describe what is recorded and whether it leaves the device.",
  photos: "The app can access your photo library. Describe what is read and whether it leaves the device.",
  contacts: "The app can access contacts. Describe what is read and whether it leaves the device.",
  health: "The app can access HealthKit data. Describe each data type, purpose, and that it is not used for advertising.",
  tracking: "The app may use identifiers for tracking. Describe what is tracked, by whom, and how users can opt out.",
  purchases: "The app offers purchases through the App Store. Describe what is purchased; payment details are handled by Apple.",
  notifications: "The app can send notifications. Describe what triggers them and how to turn them off.",
  analytics: "The app uses analytics or crash-reporting services. Name each provider, what it collects, and the retention period.",
  "sign-in-with-apple": "The app supports Sign in with Apple. Describe what account data you receive and store.",
  "local-storage": "The app stores data on the device. Describe what is stored and how a user can delete it.",
  keychain: "The app stores credentials or secrets in the device Keychain.",
};

export function privacyPolicyStarter(discovery: IosDiscovery): string {
  const name = discovery.appTarget?.name ?? "the app";
  const sections = discovery.detectedBehaviors.map((behavior) => `## ${behavior.replace(/-/g, " ")}\n\n${BEHAVIOR_SECTIONS[behavior] ?? ""}\n\n${userInput(`confirm or correct for ${behavior}`)}\n`);
  return `# Privacy Policy — ${name}\n\n> STARTER TEMPLATE, NOT LEGAL ADVICE. It was generated from what the code appears to do (${discovery.detectedBehaviors.join(", ") || "no sensitive behaviors detected"}) and may be incomplete or wrong. Have it reviewed, then publish it at a public https URL for App Store Connect.\n\n**Effective date:** ${userInput("date")}\n**Data controller / publisher:** ${userInput("legal name and contact address of the publisher")}\n**Contact:** ${userInput("privacy contact email")}\n\n## Summary\n\n${userInput("one paragraph in your own words describing what data the app collects, or states that it collects none")}\n\n${sections.join("\n")}\n## Children\n\n${userInput("state whether the app is directed to children and any age restrictions")}\n\n## Your choices and rights\n\n${userInput("how users can access, delete or export their data, and any region-specific rights that apply to you")}\n\n## Changes to this policy\n\n${userInput("how you will announce changes")}\n`;
}

export function supportStarter(discovery: IosDiscovery): string {
  return `# Support — ${discovery.appTarget?.name ?? "the app"}\n\n> STARTER TEMPLATE. Publish at a public https URL and enter that URL as the Support URL in App Store Connect.\n\n**Contact:** ${userInput("support email or contact form URL")}\n**Response time:** ${userInput("honest response-time expectation")}\n\n## Frequently asked questions\n\n${userInput("3–5 real questions and answers about using the app")}\n\n## Reporting a problem\n\nInclude: app version ${discovery.appTarget?.marketingVersion ?? "(version)"} (${discovery.appTarget?.buildNumber ?? "build"}), iOS version, device model, and steps to reproduce.\n`;
}

export function reviewNotesStarter(): string {
  return `# App Review Notes\n\nPaste or adapt this into App Store Connect → App Review Information.\n\n**How to use the app:** ${userInput("steps a reviewer needs")}\n**Demo account:** ${userInput("credentials created for review, or state that none are needed (enter in App Store Connect, not in this file)")}\n**Hardware or region requirements:** ${userInput("anything special, or 'none'")}\n**Third-party services:** ${userInput("services the reviewer should know about, or 'none'")}\n`;
}

export function exportComplianceStarter(): string {
  return `# Export Compliance\n\nApps that use encryption beyond what the operating system provides, or that implement their own cryptography, may need documentation. Apple asks about this on every upload.\n\n- Uses only HTTPS/TLS and OS-provided encryption: set ITSAppUsesNonExemptEncryption to NO in the app's Info.plist.\n- Uses custom or non-standard encryption: set it to YES and follow Apple's export compliance questions.\n\n**Your determination:** ${userInput("YES or NO, with a one-line reason; consult counsel if unsure")}\n`;
}

export function submissionChecklist(discovery: IosDiscovery, auditLines: string[] = []): string {
  const t = discovery.appTarget;
  const screenshots = screenshotRequirements(discovery).classes.map((c) => `${c.label} (${c.needed === true ? "required" : c.needed === "unknown" ? "confirm if iPad is supported" : "not needed"}): ${c.accepted.slice(0, 2).map((s) => `${s.width}×${s.height}`).join(" or ")}`);
  const lines = [
    `# App Store submission checklist${t ? ` — ${t.name} ${t.marketingVersion ?? ""} (${t.buildNumber ?? "?"})` : ""}`,
    "", "Items the agent can do are marked (agent). Items marked (you) need your Apple Developer / App Store Connect access or your own decisions. Submitting for App Review is always manual.",
    "", "## Before upload",
    "- [ ] (agent) Project discovery shows bundle ID, version and build number", "- [ ] (agent) Simulator build and unit/UI tests pass", "- [ ] (agent) Release audit has no failed or blocked items",
    "- [ ] (you) App record exists in App Store Connect for the bundle ID", "- [ ] (you) Distribution certificate and profile are available on the Mac, or an App Store Connect API key is stored in the build Keychain",
    "- [ ] (agent) Build number incremented above the last uploaded build", "- [ ] (you) Grant signing permission; then grant upload permission when ready",
    "", "## Metadata in App Store Connect", "- [ ] (you) Name, subtitle, description, keywords, category", "- [ ] (you) Support URL and Privacy Policy URL are public https pages", "- [ ] (you) App Privacy questionnaire answered truthfully", "- [ ] (you) Age rating, pricing and availability", "- [ ] (you) Copyright, review contact and demo account (if sign-in is required)", "- [ ] (you) Export compliance answered",
    "", "## Screenshots", ...screenshots.map((line) => `- [ ] (you/agent) ${line}`),
    "", "## Device testing", "- [ ] (you) Install and run on a physical iPhone; confirm core flows",
    "", "## Archive and upload", "- [ ] (agent) Archive, export and upload with verification", "- [ ] (you) Wait for App Store Connect processing, then select the build on the version page", "- [ ] (you) Click Submit for Review yourself — the agent never does this",
  ];
  if (auditLines.length) lines.push("", "## Current audit", ...auditLines.map((line) => `- ${line}`));
  return lines.join("\n") + "\n";
}

export interface TemplateWriteResult { created: string[]; skippedExisting: string[]; dryRun: boolean }

/** Create release templates without ever overwriting an existing file. */
export async function generateReleaseTemplates(root: string, discovery: IosDiscovery, dryRun = true): Promise<TemplateWriteResult> {
  const files = new Set(await listProjectFiles(root));
  const plan: Array<[string, string]> = [
    [`${RELEASE_DIR}/metadata.json`, JSON.stringify(metadataTemplate(discovery), null, 2) + "\n"],
    [`${RELEASE_DIR}/privacy-policy.md`, privacyPolicyStarter(discovery)],
    [`${RELEASE_DIR}/support.md`, supportStarter(discovery)],
    [`${RELEASE_DIR}/review-notes.md`, reviewNotesStarter()],
    [`${RELEASE_DIR}/export-compliance.md`, exportComplianceStarter()],
    [`${RELEASE_DIR}/screenshots/README.md`, `${screenshotRequirements(discovery).guidance.map((line) => `- ${line}`).join("\n")}\n`],
    [`${RELEASE_DIR}/submission-checklist.md`, submissionChecklist(discovery)],
  ];
  const result: TemplateWriteResult = { created: [], skippedExisting: [], dryRun };
  for (const [file, content] of plan) {
    if (files.has(file) || await readFile(path.join(root, file)).then(() => true, () => false)) { result.skippedExisting.push(file); continue; }
    if (!dryRun) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content, "utf8"); }
    result.created.push(file);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Validation of release files (present, non-placeholder)
// ---------------------------------------------------------------------------------------------------------------

function finding(id: string, title: string, status: Finding["status"], detail: string, remedy?: string, needsUserInput?: boolean): Finding {
  return { id, title, status, detail, ...(remedy ? { remedy } : {}), ...(needsUserInput ? { needsUserInput } : {}) };
}

async function maybeRead(root: string, file: string | undefined): Promise<string | undefined> {
  return file ? readFile(path.join(root, file), "utf8").catch(() => undefined) : undefined;
}

export const REQUIRED_METADATA_FIELDS: Array<[string, string[]]> = [
  ["App name", ["app", "name"]], ["Subtitle", ["app", "subtitle"]], ["Primary category", ["app", "primaryCategory"]],
  ["Description", ["listing", "description"]], ["Keywords", ["listing", "keywords"]], ["What's new", ["listing", "whatsNew"]], ["Copyright", ["listing", "copyright"]],
  ["Support URL", ["urls", "supportUrl"]], ["Privacy policy URL", ["urls", "privacyPolicyUrl"]], ["Pricing model", ["pricing", "model"]],
  ["Review contact email", ["review", "contact", "email"]], ["Export compliance determination", ["exportCompliance", "usesNonExemptEncryption"]],
];

export async function validateReleaseFiles(root: string, discovery: IosDiscovery): Promise<Finding[]> {
  const findings: Finding[] = [];
  const meta = discovery.metadataFiles;
  const textFile = async (id: string, title: string, file: string | undefined, hint: string) => {
    const text = await maybeRead(root, file);
    if (text === undefined) findings.push(finding(id, title, "pending", `No ${title.toLowerCase()} file found.`, `Run the template generator (writes ${RELEASE_DIR}/…) or ${hint}.`, true));
    else if (hasPlaceholder(text) || text.trim().length < 80) findings.push(finding(id, title, "pending", `${file} still contains placeholders or is nearly empty.`, `Replace every ${PLACEHOLDER_MARKER}] marker in ${file} with your own text.`, true));
    else findings.push(finding(id, title, "passed", file!));
  };
  await textFile("privacy-policy", "Privacy policy", meta.privacyPolicy, "add a privacy policy document");
  await textFile("support-content", "Support content", meta.support, "add a support page document");
  await textFile("review-notes", "App Review notes", meta.reviewNotes, `create ${RELEASE_DIR}/review-notes.md`);
  await textFile("export-compliance", "Export compliance notes", meta.exportCompliance, `create ${RELEASE_DIR}/export-compliance.md`);
  const metaText = await maybeRead(root, meta.appStoreMetadata && /metadata\.json$/.test(meta.appStoreMetadata) ? meta.appStoreMetadata : undefined);
  if (metaText === undefined) {
    findings.push(finding("app-store-metadata", "App Store metadata", meta.appStoreMetadata ? "pending" : "pending", meta.appStoreMetadata ? `${meta.appStoreMetadata} is not in the ${RELEASE_DIR}/metadata.json format this audit can validate.` : `No ${RELEASE_DIR}/metadata.json found.`, `Generate the metadata template and fill it in.`, true));
  } else {
    let parsed: unknown;
    try { parsed = JSON.parse(metaText); } catch { parsed = undefined; }
    if (!parsed) findings.push(finding("app-store-metadata", "App Store metadata", "failed", `${meta.appStoreMetadata} is not valid JSON.`, "Fix the JSON syntax."));
    else {
      const get = (keys: string[]) => keys.reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), parsed);
      const incomplete = REQUIRED_METADATA_FIELDS.filter(([, keys]) => { const value = get(keys); return typeof value !== "string" || !value.trim() || hasPlaceholder(value); }).map(([label]) => label);
      const badUrls = (["supportUrl", "privacyPolicyUrl"] as const).filter((key) => { const value = get(["urls", key]); return typeof value === "string" && value.trim() && !hasPlaceholder(value) && !/^https:\/\/[^\s/]+\.[^\s/]+/.test(value); });
      if (incomplete.length) findings.push(finding("app-store-metadata", "App Store metadata", "pending", `Incomplete: ${incomplete.join(", ")}.`, `Fill these in ${meta.appStoreMetadata}; the agent will not invent them.`, true));
      else if (badUrls.length) findings.push(finding("app-store-metadata", "App Store metadata", "failed", `${badUrls.join(", ")} must be a public https URL.`, "Correct the URL."));
      else findings.push(finding("app-store-metadata", "App Store metadata", "passed", `${meta.appStoreMetadata} is complete`));
    }
  }
  return findings;
}

export async function countScreenshots(root: string, discovery: IosDiscovery): Promise<Array<{ cls: ScreenshotClass; needed: boolean | "unknown"; valid: number; invalid: string[] }>> {
  const files = await listProjectFiles(root);
  const base = discovery.metadataFiles.screenshotsDir ?? `${RELEASE_DIR}/screenshots`;
  const needs = screenshotRequirements(discovery).classes;
  const out = [];
  for (const entry of needs) {
    const images = files.filter((file) => file.startsWith(`${base}/${entry.folder}/`) && /\.(png|jpe?g)$/i.test(file));
    let valid = 0; const invalid: string[] = [];
    for (const image of images) {
      const bytes = await readFile(path.join(root, image)).catch(() => undefined);
      const info = bytes ? pngInfo(bytes) : undefined;
      if (info && !info.alpha && entry.accepted.some((size) => size.width === info.width && size.height === info.height)) valid++;
      else invalid.push(`${path.posix.basename(image)}${info ? ` (${info.width}×${info.height}${info.alpha ? ", has alpha" : ""})` : " (unreadable or not PNG)"}`);
    }
    out.push({ cls: entry, needed: entry.needed, valid, invalid });
  }
  return out;
}
