import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverIosProject, parsePbxproj, resolveSetting, xcodebuildContainer } from "./discovery.js";
import { auditRelease } from "./audit.js";
import { bumpVersion } from "./prepare.js";
import { healthyApp, iosRepo, pbxproj, png, XCODEGEN_SPEC } from "./test-helpers.js";

test("XcodeGen project: bundle id, versions, targets, schemes, signing and metadata are discovered", async () => {
  const repo = await iosRepo({ ...healthyApp(), "PrivacyInfo.xcprivacy": "<plist/>", "Acme/Net.swift": "import Foundation\nlet s = URLSession.shared\nlet d = UserDefaults.standard\n" });
  try {
    const d = await discoverIosProject(repo.root);
    assert.equal(d.xcodeGenSpec, "project.yml");
    assert.equal(d.needsXcodeGen, true);
    assert.equal(d.appTarget?.name, "Acme");
    assert.equal(d.appTarget?.bundleId, "com.acme.app");
    assert.equal(d.appTarget?.marketingVersion, "1.2.0");
    assert.equal(d.appTarget?.buildNumber, "7");
    assert.equal(d.appTarget?.deploymentTarget, "17.0");
    assert.equal(d.appTarget?.developmentTeam, "ABCDE12345");
    assert.equal(d.appTarget?.versionSource, "project.yml");
    assert.deepEqual(d.testTargets, { unit: ["AcmeTests"], ui: ["AcmeUITests"] });
    assert.deepEqual(d.schemes, ["Acme"]);
    assert.deepEqual(d.usageDescriptions, ["NSCameraUsageDescription"]);
    assert.deepEqual(d.detectedBehaviors, ["local-storage", "network"]);
    assert.equal(d.privacyManifest, "PrivacyInfo.xcprivacy");
    assert.equal(d.appIcon.hasMarketing1024, true);
    assert.deepEqual(d.assetCatalogs, ["Acme/Assets.xcassets"]);
    assert.deepEqual(d.blockers, []);
    assert.deepEqual(xcodebuildContainer(d), { flag: "-project", file: "Acme.xcodeproj" });
  } finally { await repo.cleanup(); }
});

test("raw Xcode project: pbxproj targets, release settings, workspace preference and shared schemes", async () => {
  const repo = await iosRepo({
    "PbxApp.xcodeproj/project.pbxproj": pbxproj("2.0", "41"),
    "PbxApp.xcodeproj/xcshareddata/xcschemes/PbxApp.xcscheme": "<Scheme/>",
  });
  try {
    const d = await discoverIosProject(repo.root);
    assert.equal(d.container?.kind, "project");
    assert.equal(d.appTarget?.name, "PbxApp");
    assert.equal(d.appTarget?.bundleId, "com.acme.pbx");
    assert.equal(d.appTarget?.marketingVersion, "2.0");
    assert.equal(d.appTarget?.buildNumber, "41");
    assert.equal(d.appTarget?.deploymentTarget, "16.4");
    assert.equal(d.appTarget?.versionSource, "pbxproj");
    assert.deepEqual(d.testTargets.unit, ["PbxAppTests"]);
    assert.deepEqual(d.schemes, ["PbxApp"]);
    assert.equal(d.needsXcodeGen, false);
    assert.equal(d.facts.releaseConfiguration, true);
  } finally { await repo.cleanup(); }
  const withWorkspace = await iosRepo({ "A.xcodeproj/project.pbxproj": pbxproj(), "A.xcworkspace/contents.xcworkspacedata": "<Workspace/>" });
  try { assert.deepEqual((await discoverIosProject(withWorkspace.root)).container, { kind: "workspace", path: "A.xcworkspace" }); } finally { await withWorkspace.cleanup(); }
});

test("missing prerequisites are reported as missing/blocker, never guessed", async () => {
  const empty = await iosRepo({ "README.md": "hi" });
  try {
    const d = await discoverIosProject(empty.root);
    assert.equal(d.blockers[0]?.id, "no-project");
    assert.equal(d.appTarget, undefined);
  } finally { await empty.cleanup(); }
  const bare = await iosRepo({ "project.yml": "name: Bare\ntargets:\n  Bare:\n    type: application\n    platform: iOS\n" });
  try {
    const d = await discoverIosProject(bare.root);
    assert.deepEqual(d.missing.map((item) => item.id).sort(), ["build-number", "bundle-id", "marketing-version"]);
    assert.equal(d.appIcon.hasMarketing1024, false);
    assert.ok(d.warnings.some((item) => item.id === "app-icon"));
  } finally { await bare.cleanup(); }
  const broken = await iosRepo({ "project.yml": "name: [unclosed\n" });
  try { assert.equal((await discoverIosProject(broken.root)).blockers[0]?.id, "xcodegen-spec-invalid"); } finally { await broken.cleanup(); }
});

test("app icon analysis flags alpha, wrong size and missing files", async () => {
  const alpha = await iosRepo({ ...healthyApp(), "Acme/Assets.xcassets/AppIcon.appiconset/icon.png": png(1024, 1024, true) });
  try { assert.match((await discoverIosProject(alpha.root)).appIcon.missing.join(" "), /alpha/); } finally { await alpha.cleanup(); }
  const small = await iosRepo({ ...healthyApp(), "Acme/Assets.xcassets/AppIcon.appiconset/icon.png": png(512, 512) });
  try { assert.match((await discoverIosProject(small.root)).appIcon.missing.join(" "), /512×512/); } finally { await small.cleanup(); }
  const files = healthyApp(); delete files["Acme/Assets.xcassets/AppIcon.appiconset/icon.png"];
  const gone = await iosRepo(files);
  try { assert.match((await discoverIosProject(gone.root)).appIcon.missing.join(" "), /not found/); } finally { await gone.cleanup(); }
});

test("real-world false positives: unquoted YAML versions keep their text; CoreData and test-only APIs do not demand a privacy manifest", async () => {
  const spec = XCODEGEN_SPEC.replace('MARKETING_VERSION: "1.2.0"', "MARKETING_VERSION: 1.0").replace('CURRENT_PROJECT_VERSION: "7"', "CURRENT_PROJECT_VERSION: 1");
  const repo = await iosRepo({ ...healthyApp(), "project.yml": spec, "Acme/Store.swift": "import CoreData\nlet c = NSPersistentContainer(name: \"x\")\n", "AcmeTests/T.swift": "let t = ProcessInfo.processInfo.systemUptime\nlet d = UserDefaults.standard\n" });
  try {
    const d = await discoverIosProject(repo.root);
    assert.equal(d.appTarget?.marketingVersion, "1.0");
    assert.equal(d.appTarget?.buildNumber, "1");
    assert.equal(d.requiredReasonApis, false);
    const report = await auditRelease(repo.root, d);
    assert.equal(report.findings.find((f) => f.id === "version-metadata")?.status, "passed");
    assert.equal(report.findings.find((f) => f.id === "privacy-behavior")?.status, "passed");
    const bumped = await bumpVersion(repo.root, d, { incrementBuild: true });
    assert.deepEqual(bumped.buildNumber, { from: "1", to: "2" });
  } finally { await repo.cleanup(); }
});

test("build-setting references and pbxproj parsing", () => {
  assert.equal(resolveSetting("com.acme.$(PRODUCT_NAME)", { PRODUCT_NAME: "App" }), "com.acme.App");
  assert.equal(resolveSetting("$(UNKNOWN)", {}), "$(UNKNOWN)");
  assert.equal(parsePbxproj(pbxproj()).targets.length, 2);
});
