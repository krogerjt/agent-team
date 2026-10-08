import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { git } from "../coding/git.js";
import type { Finding, IosDiscovery, IosTarget } from "./types.js";

type Settings = Record<string, string>;

const PRODUCT_TYPES: Record<string, IosTarget["productType"]> = {
  "com.apple.product-type.application": "application",
  "com.apple.product-type.bundle.unit-test": "unit-test",
  "com.apple.product-type.bundle.ui-testing": "ui-test",
};
const MAX_SOURCE_FILES = 400;
const MAX_SOURCE_BYTES = 200_000;

async function read(root: string, relative: string): Promise<string | undefined> {
  try { return await readFile(path.join(root, relative), "utf8"); } catch { return undefined; }
}

export async function listProjectFiles(root: string): Promise<string[]> {
  const output = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return output.split("\0").filter(Boolean).map((file) => file.replaceAll("\\", "/"));
}

/** Resolve `$(NAME)` / `${NAME}` build-setting references against known settings. */
export function resolveSetting(value: string | undefined, settings: Settings, depth = 0): string | undefined {
  if (value === undefined) return undefined;
  const resolved = value.replace(/\$[({]([A-Za-z0-9_]+)(?::[^)}]*)?[)}]/g, (whole, name: string) => settings[name] !== undefined && depth < 5 ? resolveSetting(settings[name], settings, depth + 1) ?? "" : whole);
  return resolved;
}

export function parseBuildSettings(block: string): Settings {
  const settings: Settings = {};
  // Skip array-valued settings; they are never version/identity fields.
  const flat = block.replace(/\w+\s*=\s*\([\s\S]*?\);/g, "");
  for (const match of flat.matchAll(/^\s*"?([A-Za-z0-9_\[\]=*.\-]+)"?\s*=\s*("(?:[^"\\]|\\.)*"|[^;]+);/gm)) {
    settings[match[1]] = match[2].trim().replace(/^"|"$/g, "");
  }
  return settings;
}

interface PbxModel { targets: Array<{ name: string; productType: string; settings: Record<string, Settings> }>; project: Record<string, Settings> }

/** Minimal, dependency-free reader for the parts of project.pbxproj that matter for release metadata. */
export function parsePbxproj(text: string): PbxModel {
  const section = (name: string) => new RegExp(`/\\* Begin ${name} section \\*/([\\s\\S]*?)/\\* End ${name} section \\*/`).exec(text)?.[1] ?? "";
  const entries = (body: string) => [...body.matchAll(/^\t\t([0-9A-F]{8,})(?: \/\*[^*]*\*\/)? = \{([\s\S]*?)^\t\t\};/gm)].map((m) => ({ id: m[1], body: m[2] }));
  const configs = new Map<string, { name: string; settings: Settings }>();
  for (const entry of entries(section("XCBuildConfiguration"))) {
    const name = /^\s*name = ("?)([^";\n]+)\1;/m.exec(entry.body.replace(/buildSettings = \{[\s\S]*?\n\t\t\t\};/, ""))?.[2] ?? "";
    const settings = parseBuildSettings(/buildSettings = \{([\s\S]*?)\n\t\t\t\};/.exec(entry.body)?.[1] ?? "");
    configs.set(entry.id, { name, settings });
  }
  const lists = new Map<string, Record<string, Settings>>();
  for (const entry of entries(section("XCConfigurationList"))) {
    const ids = [...(/buildConfigurations = \(([\s\S]*?)\);/.exec(entry.body)?.[1] ?? "").matchAll(/([0-9A-F]{8,})/g)].map((m) => m[1]);
    lists.set(entry.id, Object.fromEntries(ids.flatMap((id) => configs.has(id) ? [[configs.get(id)!.name, configs.get(id)!.settings] as const] : [])));
  }
  const targets = entries(section("PBXNativeTarget")).map((entry) => ({
    name: /^\s*name = ("?)([^";\n]+)\1;/m.exec(entry.body)?.[2] ?? "",
    productType: /productType = "?([^";\n]+)"?;/.exec(entry.body)?.[1] ?? "",
    settings: lists.get(/buildConfigurationList = ([0-9A-F]{8,})/.exec(entry.body)?.[1] ?? "") ?? {},
  }));
  const projectEntry = entries(section("PBXProject"))[0];
  return { targets, project: projectEntry ? lists.get(/buildConfigurationList = ([0-9A-F]{8,})/.exec(projectEntry.body)?.[1] ?? "") ?? {} : {} };
}

export function pngInfo(bytes: Buffer): { width: number; height: number; alpha: boolean } | undefined {
  if (bytes.length < 26 || bytes.subarray(1, 4).toString() !== "PNG") return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), alpha: bytes[25] === 4 || bytes[25] === 6 };
}

export function plistString(text: string, key: string): string | undefined {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text)?.[1];
}

function pickConfig(configs: Record<string, Settings>): Settings {
  return configs.Release ?? configs.release ?? Object.values(configs)[0] ?? {};
}

function targetFromSettings(name: string, type: IosTarget["productType"], settings: Settings, project: Settings, source: IosTarget["versionSource"]): IosTarget {
  const merged = { ...project, ...settings };
  const bundleId = resolveSetting(merged.PRODUCT_BUNDLE_IDENTIFIER, { ...merged, PRODUCT_NAME: merged.PRODUCT_NAME === "$(TARGET_NAME)" || !merged.PRODUCT_NAME ? name : merged.PRODUCT_NAME });
  return {
    name, productType: type, bundleId,
    marketingVersion: merged.MARKETING_VERSION, buildNumber: merged.CURRENT_PROJECT_VERSION,
    deploymentTarget: merged.IPHONEOS_DEPLOYMENT_TARGET, infoPlist: merged.INFOPLIST_FILE,
    entitlements: merged.CODE_SIGN_ENTITLEMENTS, deviceFamily: merged.TARGETED_DEVICE_FAMILY, codeSignStyle: merged.CODE_SIGN_STYLE, developmentTeam: merged.DEVELOPMENT_TEAM, versionSource: source,
  };
}

interface XcodeGenSpec {
  name?: string;
  options?: { deploymentTarget?: Record<string, string> };
  settings?: { base?: Settings; configs?: Record<string, Settings> };
  targets?: Record<string, { type?: string; platform?: string; settings?: { base?: Settings; configs?: Record<string, Settings> } | Settings; info?: { path?: string; properties?: Record<string, unknown> }; deploymentTarget?: string | number; entitlements?: { path?: string } }>;
  schemes?: Record<string, unknown>;
}

function flattenXcodeGenSettings(settings: unknown, config = "Release"): Settings {
  const value = (settings ?? {}) as { base?: Settings; configs?: Record<string, Settings> } & Settings;
  const plain: Settings = {};
  for (const [key, entry] of Object.entries(value)) if (key !== "base" && key !== "configs" && key !== "groups" && (typeof entry === "string" || typeof entry === "number")) plain[key] = String(entry);
  return Object.fromEntries(Object.entries({ ...plain, ...(value.base ?? {}), ...(value.configs?.[config] ?? {}) }).map(([k, v]) => [k, String(v)]));
}

function xcodeGenTargets(spec: XcodeGenSpec): IosTarget[] {
  const project = flattenXcodeGenSettings(spec.settings);
  return Object.entries(spec.targets ?? {}).map(([name, target]) => {
    const type = target.type === "application" ? "application" : /unit-test/.test(target.type ?? "") ? "unit-test" : /ui-testing/.test(target.type ?? "") ? "ui-test" : "other";
    const settings = flattenXcodeGenSettings(target.settings);
    const props = target.info?.properties ?? {};
    const deployment = target.deploymentTarget !== undefined ? String(target.deploymentTarget) : spec.options?.deploymentTarget?.[target.platform ?? "iOS"];
    const built = targetFromSettings(name, type, { ...settings, ...(deployment && !settings.IPHONEOS_DEPLOYMENT_TARGET ? { IPHONEOS_DEPLOYMENT_TARGET: deployment } : {}) }, project, "project.yml");
    // Literal Info.plist properties in the spec win when they are not build-setting references.
    const short = typeof props.CFBundleShortVersionString === "string" ? props.CFBundleShortVersionString : undefined;
    const bundleVersion = typeof props.CFBundleVersion === "string" || typeof props.CFBundleVersion === "number" ? String(props.CFBundleVersion) : undefined;
    return {
      ...built,
      marketingVersion: resolveSetting(short, { ...project, ...settings }) ?? built.marketingVersion,
      buildNumber: resolveSetting(bundleVersion, { ...project, ...settings }) ?? built.buildNumber,
      infoPlist: target.info?.path ?? built.infoPlist,
      entitlements: target.entitlements?.path ?? built.entitlements,
    };
  });
}

interface IconAnalysis { catalog?: string; setName?: string; hasMarketing1024: boolean; missing: string[] }

async function analyzeAppIcon(root: string, files: string[], setNameHint?: string): Promise<IconAnalysis> {
  const sets = files.filter((file) => /\.appiconset\/Contents\.json$/.test(file));
  const contents = sets.find((file) => setNameHint && file.endsWith(`/${setNameHint}.appiconset/Contents.json`)) ?? sets.find((file) => /\/AppIcon\.appiconset\//.test(file)) ?? sets[0];
  if (!contents) return { hasMarketing1024: false, missing: ["No .appiconset found in an asset catalog."] };
  const folder = contents.replace(/\/Contents\.json$/, "");
  const catalog = folder.replace(/\/[^/]+\.appiconset$/, "");
  const setName = path.posix.basename(folder, ".appiconset");
  const missing: string[] = [];
  let parsed: { images?: Array<{ filename?: string; size?: string; idiom?: string; scale?: string; platform?: string }> };
  try { parsed = JSON.parse(await read(root, contents) ?? "{}"); } catch { return { catalog, setName, hasMarketing1024: false, missing: ["AppIcon Contents.json is not valid JSON."] }; }
  const images = parsed.images ?? [];
  let hasMarketing = false;
  for (const image of images) {
    const is1024 = /^1024x1024$/.test(image.size ?? "") && (image.idiom === "ios-marketing" || image.idiom === "universal" || image.platform === "ios" || !image.idiom);
    if (!image.filename) { if (is1024) missing.push("The 1024×1024 App Store icon slot has no image file."); continue; }
    if (!files.includes(`${folder}/${image.filename}`)) { missing.push(`Icon file listed but not found: ${image.filename}`); continue; }
    if (is1024) {
      hasMarketing = true;
      const bytes = await readFile(path.join(root, folder, image.filename)).catch(() => undefined);
      const info = bytes ? pngInfo(bytes) : undefined;
      if (info) {
        if (info.alpha) missing.push(`${image.filename} has an alpha channel; the App Store icon must be opaque.`);
        if (info.width !== 1024 || info.height !== 1024) missing.push(`${image.filename} is ${info.width}×${info.height}, not 1024×1024.`);
      }
    }
  }
  if (!hasMarketing) missing.push("No 1024×1024 App Store marketing icon is set.");
  return { catalog, setName, hasMarketing1024: hasMarketing && missing.length === 0, missing: [...new Set(missing)] };
}

/** APIs Apple makes apps justify in a privacy manifest (UserDefaults, file timestamps, boot time, disk space, active keyboards). CoreData/SwiftData alone are not on the list. */
const REQUIRED_REASON_APIS = /\bUserDefaults\b|@AppStorage|\bsystemUptime\b|mach_absolute_time|\bcontentModificationDateKey\b|\bcreationDateKey\b|\.creationDate\b|\.modificationDate\b|volumeAvailableCapacity|\bstatfs\b|NSFileSystemFreeSize|activeInputModes/;

const BEHAVIORS: Array<[string, RegExp]> = [
  ["network", /\bURLSession\b|\bAlamofire\b|\bURLRequest\b/], ["location", /\bCLLocationManager\b/], ["camera", /AVCaptureDevice|AVCaptureSession|UIImagePickerController/],
  ["microphone", /AVAudioRecorder|AVAudioEngine|AVAudioSession\b.*record/], ["photos", /\bPHPhotoLibrary\b|\bPhotosPicker\b/], ["contacts", /\bCNContactStore\b/],
  ["health", /\bHKHealthStore\b/], ["tracking", /\bATTrackingManager\b|\bASIdentifierManager\b/], ["purchases", /\bStoreKit\b|\bProduct\.products\b/],
  ["notifications", /\bUNUserNotificationCenter\b/], ["analytics", /\bFirebaseAnalytics\b|\bAnalytics\.logEvent\b|\bSentry\b|\bCrashlytics\b|\bMixpanel\b|\bAmplitude\b/],
  ["sign-in-with-apple", /\bASAuthorizationAppleIDProvider\b|\bSignInWithAppleButton\b/], ["local-storage", /\bUserDefaults\b|\bSwiftData\b|\bCoreData\b|NSPersistentContainer/],
  ["keychain", /\bSecItemAdd\b|\bkSecClass\b/],
];

function finding(id: string, title: string, status: Finding["status"], detail: string, remedy?: string, needsUserInput?: boolean): Finding {
  return { id, title, status, detail, ...(remedy ? { remedy } : {}), ...(needsUserInput ? { needsUserInput } : {}) };
}

/** Inspect an iOS repository. Facts come only from files; everything absent is reported as missing, never guessed. */
export async function discoverIosProject(root: string): Promise<IosDiscovery> {
  const files = await listProjectFiles(root);
  const warnings: Finding[] = [], blockers: Finding[] = [], missing: Finding[] = [];
  const specName = ["project.yml", "project.yaml"].find((name) => files.includes(name));
  const workspaces = [...new Set(files.filter((f) => /\.xcworkspace\/contents\.xcworkspacedata$/.test(f) && !/\.xcodeproj\//.test(f)).map((f) => f.replace(/\/contents\.xcworkspacedata$/, "")))];
  const projects = [...new Set(files.filter((f) => /\.xcodeproj\/project\.pbxproj$/.test(f)).map((f) => f.replace(/\/project\.pbxproj$/, "")))];
  let container: IosDiscovery["container"];
  if (workspaces.length === 1) container = { kind: "workspace", path: workspaces[0] };
  else if (workspaces.length === 0 && projects.length === 1) container = { kind: "project", path: projects[0] };
  else if (workspaces.length + projects.length > 1) warnings.push(finding("container-ambiguous", "Several Xcode containers", "pending", `Found ${[...workspaces, ...projects].join(", ")}.`, "Tell the agent which workspace or project to build.", true));

  let targets: IosTarget[] = [];
  let spec: XcodeGenSpec | undefined;
  let schemes: string[] = [];
  let hasReleaseConfig = false;
  if (specName) {
    try { // failsafe schema keeps every scalar as written, so `MARKETING_VERSION: 1.0` stays "1.0" and not the number 1.
    spec = parseYaml(await read(root, specName) ?? "", { schema: "failsafe" }) as XcodeGenSpec; targets = xcodeGenTargets(spec ?? {}); }
    catch (error) { blockers.push(finding("xcodegen-spec-invalid", "XcodeGen spec cannot be parsed", "blocked", `${specName}: ${error instanceof Error ? error.message : String(error)}`, `Fix the YAML syntax in ${specName}.`)); }
    schemes = Object.keys(spec?.schemes ?? {});
    if (!schemes.length) schemes = targets.filter((t) => t.productType === "application").map((t) => t.name);
  }
  if (!targets.length && projects.length) {
    const pbx = await read(root, `${container?.kind === "project" ? container.path : projects[0]}/project.pbxproj`);
    if (pbx) {
      const model = parsePbxproj(pbx);
      const project = pickConfig(model.project);
      hasReleaseConfig = model.targets.some((t) => "Release" in t.settings) || "Release" in model.project;
      targets = model.targets.map((t) => targetFromSettings(t.name, PRODUCT_TYPES[t.productType] ?? "other", pickConfig(t.settings), project, "pbxproj"));
    }
  }
  schemes = [...new Set([...schemes, ...files.filter((f) => /xcshareddata\/xcschemes\/[^/]+\.xcscheme$/.test(f)).map((f) => path.posix.basename(f, ".xcscheme"))])];

  // Info.plist can hold literal version values, or point back at build settings.
  for (const target of targets) {
    if (!target.infoPlist || target.productType !== "application") continue;
    const plistPath = target.infoPlist.replace(/^\$\(SRCROOT\)\/?/, "");
    const plist = await read(root, plistPath);
    if (!plist) continue;
    const short = plistString(plist, "CFBundleShortVersionString"), build = plistString(plist, "CFBundleVersion"), id = plistString(plist, "CFBundleIdentifier");
    if (short && !short.startsWith("$(")) { target.marketingVersion = short; target.versionSource = "info-plist"; }
    if (build && !build.startsWith("$(")) { target.buildNumber = build; target.versionSource = "info-plist"; }
    if (!target.bundleId && id && !id.startsWith("$(")) target.bundleId = id;
  }

  const appTarget = targets.find((t) => t.productType === "application");
  const testTargets = { unit: targets.filter((t) => t.productType === "unit-test").map((t) => t.name), ui: targets.filter((t) => t.productType === "ui-test").map((t) => t.name) };
  const assetCatalogs = [...new Set(files.filter((f) => /\.xcassets\//.test(f)).map((f) => f.replace(/(\.xcassets)\/.*$/, "$1")))];
  const iconHint = spec?.targets && appTarget ? flattenXcodeGenSettings(spec.targets[appTarget.name]?.settings).ASSETCATALOG_COMPILER_APPICON_NAME : undefined;
  const appIcon = await analyzeAppIcon(root, files, iconHint);

  const find = (pattern: RegExp) => files.find((f) => pattern.test(f));
  const metadataFiles: IosDiscovery["metadataFiles"] = {
    privacyPolicy: find(/(^|\/)(release\/privacy-policy|privacy[-_ ]?policy|PRIVACY)[^/]*\.(md|html|txt)$/i),
    support: find(/(^|\/)(release\/support|support|SUPPORT)[^/]*\.(md|html|txt)$/i),
    appStoreMetadata: find(/(^|\/)release\/metadata\.json$/) ?? find(/(^|\/)fastlane\/metadata\//) ?? find(/(^|\/)(app-store|appstore)[-_]?metadata[^/]*\.(json|ya?ml)$/i),
    releaseNotes: find(/(^|\/)(release\/release-notes|release-notes|CHANGELOG)[^/]*\.md$/i),
    exportCompliance: find(/(^|\/)release\/export-compliance\.md$/),
    reviewNotes: find(/(^|\/)release\/review-notes\.md$/),
    screenshotsDir: find(/(^|\/)release\/screenshots\//)?.replace(/(release\/screenshots)\/.*$/, "$1") ?? find(/(^|\/)fastlane\/screenshots\//)?.replace(/(fastlane\/screenshots)\/.*$/, "$1"),
  };
  const privacyManifest = find(/(^|\/)PrivacyInfo\.xcprivacy$/);

  // Test code does not ship, so it must not trigger privacy or capability findings.
  const sources = files.filter((f) => /\.(swift|m|mm)$/.test(f) && !/(^|\/)[^/]*(Tests?|UITests?)\//.test(f)).slice(0, MAX_SOURCE_FILES);
  let requiredReasonApis = false;
  const behaviors = new Set<string>();
  const usage = new Set<string>();
  for (const file of sources) {
    const text = await read(root, file); if (!text || text.length > MAX_SOURCE_BYTES) continue;
    for (const [name, pattern] of BEHAVIORS) if (pattern.test(text)) behaviors.add(name);
    if (REQUIRED_REASON_APIS.test(text)) requiredReasonApis = true;
  }
  const plistTexts = await Promise.all(files.filter((f) => /(^|\/)Info\.plist$/.test(f)).map((f) => read(root, f)));
  for (const text of [...plistTexts, specName ? await read(root, specName) : undefined]) for (const m of (text ?? "").matchAll(/\bNS[A-Za-z]+UsageDescription\b/g)) usage.add(m[0]);
  if (spec) for (const m of JSON.stringify(spec).matchAll(/INFOPLIST_KEY_(NS[A-Za-z]+UsageDescription)/g)) usage.add(m[1]);
  if (container) for (const p of projects) for (const m of (await read(root, `${p}/project.pbxproj`) ?? "").matchAll(/INFOPLIST_KEY_(NS[A-Za-z]+UsageDescription)/g)) usage.add(m[1]);

  const releaseConfigExists = specName ? !spec?.settings?.configs || "Release" in spec.settings.configs : Boolean(appTarget) && hasReleaseConfig;
  if (!container && !specName) blockers.push(finding("no-project", "No Xcode project found", "blocked", "No .xcworkspace, .xcodeproj, or XcodeGen project.yml/project.yaml is tracked in this repository.", "Add the iOS project to the repository, or point the agent at the correct repository."));
  else if (!appTarget && !blockers.length) blockers.push(finding("no-app-target", "No iOS application target", "blocked", `Found ${targets.length} target(s) but none is an application.`, "Confirm the app target is defined in the project or XcodeGen spec."));
  if (appTarget) {
    if (!appTarget.bundleId) missing.push(finding("bundle-id", "Bundle identifier", "failed", "PRODUCT_BUNDLE_IDENTIFIER could not be resolved for the app target.", "Set PRODUCT_BUNDLE_IDENTIFIER (a reverse-DNS id you own) in the app target.", true));
    if (!appTarget.marketingVersion) missing.push(finding("marketing-version", "Marketing version", "failed", "MARKETING_VERSION / CFBundleShortVersionString is not set.", "Set MARKETING_VERSION, for example 1.0.0."));
    if (!appTarget.buildNumber) missing.push(finding("build-number", "Build number", "failed", "CURRENT_PROJECT_VERSION / CFBundleVersion is not set.", "Set CURRENT_PROJECT_VERSION to an integer."));
    if (!appTarget.deploymentTarget) warnings.push(finding("deployment-target", "Deployment target", "pending", "IPHONEOS_DEPLOYMENT_TARGET is not set explicitly.", "Set it so the minimum supported iOS version is deliberate."));
  }
  if (!appIcon.hasMarketing1024) warnings.push(finding("app-icon", "App icon", "failed", appIcon.missing.join(" ") || "App icon is incomplete.", "Provide an opaque 1024×1024 PNG in the AppIcon set (create_png can render an SVG)."));

  const facts: IosDiscovery["facts"] = {
    container: container ? `${container.kind}: ${container.path}` : undefined,
    xcodeGenSpec: specName, schemes, appTarget: appTarget?.name, bundleId: appTarget?.bundleId,
    marketingVersion: appTarget?.marketingVersion, buildNumber: appTarget?.buildNumber, deploymentTarget: appTarget?.deploymentTarget,
    versionSource: appTarget?.versionSource, assetCatalogs, unitTestTargets: testTargets.unit, uiTestTargets: testTargets.ui,
    signingStyle: appTarget?.codeSignStyle, developmentTeamConfigured: Boolean(appTarget?.developmentTeam), releaseConfiguration: releaseConfigExists,
    privacyManifest, usageDescriptions: [...usage].sort(), detectedBehaviors: [...behaviors].sort(), usesRequiredReasonApis: requiredReasonApis,
    usesCocoaPods: files.includes("Podfile"), usesBundler: files.includes("Gemfile"),
  };
  const needsXcodeGen = Boolean(specName) && !projects.length;
  return { root, facts, container, xcodeGenSpec: specName, xcodeGenProjectName: spec?.name && /^[A-Za-z0-9_. -]+$/.test(spec.name) ? spec.name : undefined, needsXcodeGen, targets, appTarget, schemes, testTargets, assetCatalogs, appIcon, metadataFiles, privacyManifest, usageDescriptions: [...usage].sort(), detectedBehaviors: [...behaviors].sort(), requiredReasonApis, warnings, blockers, missing };
}

/** Container flags for xcodebuild, accounting for a project that only exists after XcodeGen runs. */
export function xcodebuildContainer(discovery: IosDiscovery): { flag: "-workspace" | "-project"; file: string } | undefined {
  if (discovery.container) return { flag: discovery.container.kind === "workspace" ? "-workspace" : "-project", file: discovery.container.path };
  return discovery.xcodeGenProjectName ? { flag: "-project", file: `${discovery.xcodeGenProjectName}.xcodeproj` } : undefined;
}
