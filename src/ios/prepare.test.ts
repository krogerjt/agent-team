import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { discoverIosProject } from "./discovery.js";
import { bumpVersion, generateReleaseTemplates, hasPlaceholder, nextBuildNumber, privacyPolicyStarter, screenshotRequirements, submissionChecklist, validateReleaseFiles } from "./prepare.js";
import { healthyApp, iosRepo, pbxproj } from "./test-helpers.js";

test("build number increments in project.yml, dry run by default, never touching other values", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    const dry = await bumpVersion(repo.root, d, { incrementBuild: true });
    assert.equal(dry.dryRun, true); assert.equal(dry.applied, false);
    assert.deepEqual(dry.buildNumber, { from: "7", to: "8" });
    assert.match(await readFile(path.join(repo.root, "project.yml"), "utf8"), /CURRENT_PROJECT_VERSION: "7"/);
    const applied = await bumpVersion(repo.root, d, { incrementBuild: true, marketingVersion: "1.3.0", dryRun: false });
    assert.equal(applied.applied, true);
    const text = await readFile(path.join(repo.root, "project.yml"), "utf8");
    assert.match(text, /CURRENT_PROJECT_VERSION: "8"/); assert.match(text, /MARKETING_VERSION: "1.3.0"/);
    assert.match(text, /PRODUCT_BUNDLE_IDENTIFIER: com.acme.app/);
    assert.equal((await discoverIosProject(repo.root)).appTarget?.buildNumber, "8");
  } finally { await repo.cleanup(); }
});

test("version edits work in pbxproj and refuse when no literal value exists", async () => {
  const repo = await iosRepo({ "PbxApp.xcodeproj/project.pbxproj": pbxproj("2.0", "41") });
  try {
    const d = await discoverIosProject(repo.root);
    await bumpVersion(repo.root, d, { incrementBuild: true, dryRun: false });
    const text = await readFile(path.join(repo.root, "PbxApp.xcodeproj/project.pbxproj"), "utf8");
    assert.equal((text.match(/CURRENT_PROJECT_VERSION = 42;/g) ?? []).length, 2);
    assert.equal((text.match(/CURRENT_PROJECT_VERSION = 41;/g) ?? []).length, 0);
  } finally { await repo.cleanup(); }
  const bare = await iosRepo({ "project.yml": "name: Bare\ntargets:\n  Bare:\n    type: application\n    platform: iOS\n" });
  try { await assert.rejects(async () => bumpVersion(bare.root, await discoverIosProject(bare.root), { incrementBuild: true }), /not set/); } finally { await bare.cleanup(); }
});

test("version validation", async () => {
  assert.equal(nextBuildNumber("9"), "10"); assert.equal(nextBuildNumber("1.4"), "1.5");
  assert.throws(() => nextBuildNumber("abc"));
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    await assert.rejects(() => bumpVersion(repo.root, d, { marketingVersion: "one" }), /Invalid marketing version/);
    const down = await bumpVersion(repo.root, d, { marketingVersion: "1.1.0" });
    assert.match(down.warnings.join(" "), /goes down/);
  } finally { await repo.cleanup(); }
});

test("templates use explicit placeholders, reflect detected behavior, never overwrite, and invent nothing", async () => {
  const repo = await iosRepo({ ...healthyApp(), "Acme/Loc.swift": "import CoreLocation\nlet m = CLLocationManager()\n", "release/support.md": "# my support page\nreal text\n" });
  try {
    const d = await discoverIosProject(repo.root);
    const dry = await generateReleaseTemplates(repo.root, d, true);
    assert.equal(dry.dryRun, true);
    assert.ok(dry.skippedExisting.includes("release/support.md"));
    assert.equal((await discoverIosProject(repo.root)).metadataFiles.privacyPolicy, undefined);
    const written = await generateReleaseTemplates(repo.root, d, false);
    assert.ok(written.created.includes("release/metadata.json"));
    assert.equal(await readFile(path.join(repo.root, "release/support.md"), "utf8"), "# my support page\nreal text\n");
    const policy = await readFile(path.join(repo.root, "release/privacy-policy.md"), "utf8");
    assert.match(policy, /NOT LEGAL ADVICE/); assert.match(policy, /## location/);
    assert.ok(!/https?:\/\//.test(policy));
    const metadata = JSON.parse(await readFile(path.join(repo.root, "release/metadata.json"), "utf8"));
    assert.match(metadata.urls.supportUrl, /REQUIRES USER INPUT/);
    assert.match(metadata.listing.copyright, /REQUIRES USER INPUT/);
    assert.equal(metadata.app.bundleId, "com.acme.app");
    assert.equal(hasPlaceholder(policy), true);
    assert.match(privacyPolicyStarter(d), /Effective date/);
  } finally { await repo.cleanup(); }
});

test("release file validation distinguishes missing, placeholder and complete files", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    let d = await discoverIosProject(repo.root);
    let findings = await validateReleaseFiles(repo.root, d);
    assert.ok(findings.every((f) => f.status === "pending"));
    await generateReleaseTemplates(repo.root, d, false);
    d = await discoverIosProject(repo.root);
    findings = await validateReleaseFiles(repo.root, d);
    assert.ok(findings.every((f) => f.status === "pending" && /placeholder|Incomplete/i.test(f.detail)));
    const { writeFile } = await import("node:fs/promises");
    const prose = "This is a complete, real document written by the app owner. ".repeat(4);
    for (const name of ["privacy-policy", "support", "review-notes", "export-compliance"]) await writeFile(path.join(repo.root, `release/${name}.md`), prose);
    const meta = { app: { name: "Acme", subtitle: "Receipts", primaryCategory: "Finance" }, listing: { description: "d", keywords: "k", whatsNew: "w", copyright: "2026 Acme Ltd" }, urls: { supportUrl: "https://acme.test/support", privacyPolicyUrl: "https://acme.test/privacy" }, pricing: { model: "free" }, review: { contact: { email: "a@acme.test" } }, exportCompliance: { usesNonExemptEncryption: "false" } };
    await writeFile(path.join(repo.root, "release/metadata.json"), JSON.stringify(meta));
    d = await discoverIosProject(repo.root);
    findings = await validateReleaseFiles(repo.root, d);
    assert.deepEqual(findings.filter((f) => f.status !== "passed"), []);
    meta.urls.supportUrl = "http://insecure.test";
    await writeFile(path.join(repo.root, "release/metadata.json"), JSON.stringify(meta));
    assert.equal((await validateReleaseFiles(repo.root, d)).find((f) => f.id === "app-store-metadata")?.status, "failed");
  } finally { await repo.cleanup(); }
});

test("screenshot requirements and checklist", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    const req = screenshotRequirements(d);
    assert.equal(req.classes.find((c) => c.id === "iphone-6.9")?.needed, true);
    assert.equal(req.classes.find((c) => c.id === "ipad-13")?.needed, false);
    assert.ok(req.guidance.some((line) => /simctl io/.test(line)));
    const list = submissionChecklist(d, ["PENDING: x"]);
    assert.match(list, /Submit for Review yourself/); assert.match(list, /\(you\)/); assert.match(list, /PENDING: x/);
  } finally { await repo.cleanup(); }
});
