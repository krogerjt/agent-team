import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { auditRelease, stripDebugBlocks } from "./audit.js";
import { discoverIosProject } from "./discovery.js";
import { generateReleaseTemplates } from "./prepare.js";
import { groupFindings } from "./report.js";
import { healthyApp, iosRepo, png } from "./test-helpers.js";

const find = (report: Awaited<ReturnType<typeof auditRelease>>, id: string) => report.findings.find((f) => f.id === id)!;

async function completeRelease(root: string): Promise<void> {
  const prose = "This is a complete, real document written by the app owner. ".repeat(4);
  await mkdir(path.join(root, "release/screenshots/iphone-6.9"), { recursive: true });
  for (const name of ["privacy-policy", "support", "review-notes", "export-compliance"]) await writeFile(path.join(root, `release/${name}.md`), prose);
  const meta = { app: { name: "Acme", subtitle: "Receipts", primaryCategory: "Finance" }, listing: { description: "d", keywords: "k", whatsNew: "w", copyright: "2026 Acme Ltd" }, urls: { supportUrl: "https://acme.test/support", privacyPolicyUrl: "https://acme.test/privacy" }, pricing: { model: "free" }, review: { contact: { email: "a@acme.test" } }, exportCompliance: { usesNonExemptEncryption: "false" } };
  await writeFile(path.join(root, "release/metadata.json"), JSON.stringify(meta));
  await writeFile(path.join(root, "release/screenshots/iphone-6.9/1.png"), png(1320, 2868));
}

test("fresh app: audit reports pending user work, never passes unverifiable items, and groups results", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    await generateReleaseTemplates(repo.root, d, false);
    const report = await auditRelease(repo.root, await discoverIosProject(repo.root));
    assert.equal(report.ok, true, report.text);
    assert.equal(find(report, "bundle-id").status, "passed");
    assert.equal(find(report, "version-metadata").status, "passed");
    assert.equal(find(report, "build-number").status, "pending");
    assert.equal(find(report, "tests").status, "pending");
    assert.equal(find(report, "physical-device").status, "pending");
    assert.equal(find(report, "privacy-policy").status, "pending");
    assert.equal(find(report, "app-store-metadata").status, "pending");
    assert.equal(find(report, "screenshots-iphone-6.9").status, "pending");
    assert.equal(find(report, "encryption-key").status, "passed");
    assert.equal(find(report, "release-signing").status, "pending");
    assert.match(report.text, /PENDING \(/);
    const groups = groupFindings(report.findings);
    assert.equal(groups.passed.length + groups.failed.length + groups.pending.length + groups.blocked.length, report.findings.length);
    assert.doesNotThrow(() => JSON.stringify(report));
  } finally { await repo.cleanup(); }
});

test("fully prepared app with recorded evidence passes everything automatable", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await completeRelease(repo.root);
    const report = await auditRelease(repo.root, await discoverIosProject(repo.root), { unitTests: "passed", uiTests: "passed", simulatorBuild: "passed", deviceTest: "passed", distributionIdentityAvailable: true, lastUploadedBuild: "6" });
    // Build-number uniqueness can only ever be fully verified against App Store Connect, so it honestly stays pending.
    assert.deepEqual(report.findings.filter((f) => f.status !== "passed").map((f) => `${f.id}:${f.status}`), ["build-number:pending"], report.text);
    assert.equal(report.counts.failed, 0);
  } finally { await repo.cleanup(); }
});

test("build number: duplicates fail, unknown stays pending", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    assert.equal(find(await auditRelease(repo.root, d, { lastUploadedBuild: "7" }), "build-number").status, "failed");
    assert.equal(find(await auditRelease(repo.root, d, { knownRemoteBuilds: ["7"] }), "build-number").status, "failed");
    assert.equal(find(await auditRelease(repo.root, d, { lastUploadedBuild: "6" }), "build-number").status, "pending");
  } finally { await repo.cleanup(); }
});

test("signing without a distribution identity is blocked; failed tests and builds fail the audit", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    const report = await auditRelease(repo.root, d, { distributionIdentityAvailable: false, unitTests: "failed", simulatorBuild: "failed", deviceTest: "failed" });
    assert.equal(find(report, "release-signing").status, "blocked");
    assert.equal(find(report, "tests").status, "failed");
    assert.equal(find(report, "simulator-build").status, "failed");
    assert.equal(find(report, "physical-device").status, "failed");
    assert.equal(report.ok, false);
  } finally { await repo.cleanup(); }
});

test("debug-only settings and development endpoints are flagged unless guarded by #if DEBUG", async () => {
  const guarded = `import Foundation\n#if DEBUG\nlet api = "http://localhost:8080"\n#else\nlet api = "https://api.acme.test"\n#endif\n`;
  const ok = await iosRepo({ ...healthyApp(), "Acme/Config.swift": guarded });
  try { assert.equal(find(await auditRelease(ok.root, await discoverIosProject(ok.root)), "debug-settings").status, "passed"); } finally { await ok.cleanup(); }
  const bad = await iosRepo({ ...healthyApp(), "Acme/Config.swift": `let api = "http://192.168.1.20:3000"\n`, "Acme/Info.plist": "<plist><dict><key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict></dict></plist>", "Acme/Acme.entitlements": "<plist><dict><key>get-task-allow</key><true/></dict></plist>" });
  try {
    const finding = find(await auditRelease(bad.root, await discoverIosProject(bad.root)), "debug-settings");
    assert.equal(finding.status, "failed");
    assert.match(finding.detail, /192\.168\.1\.20/); assert.match(finding.detail, /arbitrary loads/); assert.match(finding.detail, /get-task-allow/);
  } finally { await bad.cleanup(); }
  assert.equal(stripDebugBlocks("a\n#if DEBUG\nsecret\n#endif\nb"), "a\nb");
  assert.equal(stripDebugBlocks("#if DEBUG\nd\n#else\nrelease\n#endif"), "release");
});

test("privacy behavior needs purpose strings and a privacy manifest", async () => {
  const repo = await iosRepo({ ...healthyApp(), "Acme/Loc.swift": "let m = CLLocationManager()\nlet d = UserDefaults.standard\n" });
  try {
    const finding = find(await auditRelease(repo.root, await discoverIosProject(repo.root)), "privacy-behavior");
    assert.equal(finding.status, "failed");
    assert.match(finding.detail, /NSLocationWhenInUseUsageDescription/); assert.match(finding.detail, /PrivacyInfo\.xcprivacy/);
  } finally { await repo.cleanup(); }
});

test("screenshots are validated by exact size and alpha", async () => {
  const repo = await iosRepo({ ...healthyApp(), "release/screenshots/iphone-6.9/bad.png": png(1000, 2000), "release/screenshots/iphone-6.9/alpha.png": png(1320, 2868, true) });
  try {
    const finding = find(await auditRelease(repo.root, await discoverIosProject(repo.root)), "screenshots-iphone-6.9");
    assert.equal(finding.status, "failed");
    assert.match(finding.detail, /1000×2000/); assert.match(finding.detail, /alpha/);
  } finally { await repo.cleanup(); }
});

test("a repository with no project is blocked rather than audited", async () => {
  const repo = await iosRepo({ "README.md": "x" });
  try {
    const report = await auditRelease(repo.root, await discoverIosProject(repo.root));
    assert.equal(report.ok, false); assert.equal(report.counts.blocked, 1);
  } finally { await repo.cleanup(); }
});
