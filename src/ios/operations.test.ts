import assert from "node:assert/strict";
import { test } from "node:test";
import { git } from "../coding/git.js";
import { discoverIosProject } from "./discovery.js";
import { captureRunContext, gateOperation, runIosOperation, type OperationDeps } from "./operations.js";
import { readIosState } from "./store.js";
import { baseDeps, healthyApp, iosRepo, withData, type IosRepo } from "./test-helpers.js";

const KEY = { keyIdSecret: "asc-key-id", issuerIdSecret: "asc-issuer-id", privateKeySecret: "asc-key-p8-b64" };
const SIM = JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [{ name: "iPhone 17", udid: "SIM-UDID-1", isAvailable: true, state: "Booted" }] } });
const PROBE_DEVICE = "MACOS\t15.1\nDEVICE\tJane's iPhone (18.1) (00008110-001A2B3C4D5E6F78)\n";

interface Mac { calls: string[]; mainScripts: string[]; deps: (extra?: Partial<OperationDeps>) => OperationDeps }

function reply(markers: Record<string, string> = {}, output = "", exit = 0): { code: number; output: string } {
  return { code: 0, output: `${output}\n@@NONCE:EXIT=${exit}\n${Object.entries(markers).map(([k, v]) => `@@NONCE:${k}=${v}`).join("\n")}\n` };
}

function mac(repo: IosRepo, main: (script: string) => { code: number; output: string }, extra: Record<string, (script: string) => { code: number; output: string }> = {}): Mac {
  const calls: string[] = [], mainScripts: string[] = [];
  const run: OperationDeps["run"] = async (_host, script) => {
    calls.push(script);
    if (script.includes("@@NONCE:EXIT")) { mainScripts.push(script); return main(script); }
    for (const [needle, handler] of Object.entries(extra)) if (script.includes(needle)) return handler(script);
    if (script.includes("simctl list devices available --json")) return { code: 0, output: SIM };
    return { code: 0, output: "" };
  };
  return { calls, mainScripts, deps: (more = {}) => baseDeps(repo, run, { persist: false, ...more }) };
}

const signing = { permissions: { signing: true, upload: false }, apiKey: KEY };
const stateWith = (extra: Record<string, unknown> = {}) => ({ settings: signing, steps: {}, ...extra }) as OperationDeps["state"];

test("dry run shows commands, touches neither the Mac nor the project", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    const before = await git(repo.root, ["status", "--porcelain", "--untracked-files=all"]);
    const m = mac(repo, () => { throw new Error("must not run"); });
    const result = await runIosOperation(repo.root, d, { operation: "build-simulator", dryRun: true }, m.deps());
    assert.equal(result.status, "dry-run"); assert.equal(result.verified, false);
    assert.equal(m.calls.length, 0);
    assert.match(result.commands.join("\n"), /xcodegen generate --spec project.yml/);
    assert.match(result.commands.join("\n"), /xcodebuild -project Acme.xcodeproj -scheme Acme/);
    assert.match(result.summary, /Nothing was signed/);
    assert.equal(await git(repo.root, ["status", "--porcelain", "--untracked-files=all"]), before);
    const archive = await runIosOperation(repo.root, d, { operation: "archive", dryRun: true }, m.deps({ settings: signing.permissions ? { ...signing } : signing, state: stateWith() }));
    assert.equal(archive.status, "dry-run");
    assert.match(archive.commands.join("\n"), /\$ASC_KEY_ID/);
    assert.equal(m.calls.length, 0);
  } finally { await repo.cleanup(); }
});

test("signing and upload need separate user-granted permissions; the agent path cannot grant them", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    const m = mac(repo, () => { throw new Error("must not run"); });
    for (const operation of ["archive", "export", "build-release", "install-device"] as const) {
      const r = await runIosOperation(repo.root, d, { operation }, m.deps());
      assert.equal(r.status, "blocked", operation); assert.equal(r.failureClass, "permission-denied");
      assert.match(r.remedy!, /grant signing/);
    }
    const up = await runIosOperation(repo.root, d, { operation: "upload" }, m.deps({ settings: { permissions: { signing: true, upload: false } } }));
    assert.equal(up.failureClass, "permission-denied"); assert.match(up.remedy!, /grant upload/);
    assert.equal(m.calls.length, 0);
    const ctx = await captureRunContext(repo.root);
    const noKey = gateOperation({ operation: "upload" }, d, { host: baseDeps(repo, undefined).host, settings: { permissions: { signing: true, upload: true } }, state: stateWith({ lastExport: { ipaPath: "x.ipa", exportPath: "x", treeHash: ctx.treeHash, at: "", id: "a" } }) }, ctx);
    assert.equal(noKey.blocked?.failureClass, "credentials-missing");
  } finally { await repo.cleanup(); }
});

test("a disabled host, missing team id and no project are blocked with exact fixes", async () => {
  const repo = await iosRepo(healthyApp());
  const bare = await iosRepo({ "README.md": "x" });
  try {
    const d = await discoverIosProject(repo.root);
    const m = mac(repo, () => { throw new Error("must not run"); });
    const off = await runIosOperation(repo.root, d, { operation: "build-simulator" }, m.deps({ host: { enabled: false, target: "", root: ".agent-team-builder" } }));
    assert.equal(off.status, "blocked"); assert.match(off.remedy!, /Workshop Options/);
    const noTeam = { ...d, appTarget: { ...d.appTarget!, developmentTeam: undefined } };
    const team = await runIosOperation(repo.root, noTeam, { operation: "archive" }, m.deps({ settings: signing, state: stateWith() }));
    assert.equal(team.failureClass, "account-team"); assert.match(team.remedy!, /Team ID/);
    const none = await runIosOperation(bare.root, await discoverIosProject(bare.root), { operation: "build-simulator" }, m.deps());
    assert.equal(none.status, "blocked");
  } finally { await repo.cleanup(); await bare.cleanup(); }
});

test("simulator build succeeds only with a BUILD SUCCEEDED line and an .app; exit 0 alone is not success", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    const ok = mac(repo, () => reply({ SUCCEEDED: "1", APP: "1" }, "** BUILD SUCCEEDED **"));
    const good = await runIosOperation(repo.root, d, { operation: "build-simulator" }, ok.deps());
    assert.equal(good.status, "success"); assert.equal(good.verified, true);
    const uploads: string[] = [];
    const bad = mac(repo, () => reply({}, "warning: nothing built"));
    const r = await runIosOperation(repo.root, d, { operation: "build-simulator" }, bad.deps({ uploadSource: async (_r, _h, dest) => { uploads.push(dest); } }));
    assert.equal(r.status, "failed"); assert.equal(r.failureClass, "verification"); assert.equal(r.verified, false);
    assert.match(r.summary, /not counted as successful/);
    assert.equal(uploads.length, 1);
    const forged = mac(repo, () => ({ code: 0, output: `@@OTHER:SUCCEEDED=1\n@@NONCE:EXIT=0\n` }));
    assert.equal((await runIosOperation(repo.root, d, { operation: "build-simulator" }, forged.deps())).status, "failed");
    const nomarker = mac(repo, () => ({ code: 0, output: "** BUILD SUCCEEDED **" }));
    const r2 = await runIosOperation(repo.root, d, { operation: "build-simulator" }, nomarker.deps());
    assert.equal(r2.status, "failed"); assert.match(r2.summary, /no completion marker/);
  } finally { await repo.cleanup(); }
});

test("a failing build is classified, redacted, and cleaned up on the Mac", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    const m = mac(repo, () => reply({}, "error: No signing certificate \"Apple Distribution\" found\nxcrun altool --apiKey LEAKEDKEY1 --apiIssuer 69a6de70-03db-47e3-e053-5b8c7c11a4d1", 65));
    const r = await runIosOperation(repo.root, d, { operation: "archive" }, m.deps({ settings: signing, state: stateWith() }));
    assert.equal(r.status, "failed"); assert.equal(r.failureClass, "signing-identity");
    assert.match(r.remedy!, /Distribution certificate/);
    assert.ok(!JSON.stringify(r).includes("LEAKEDKEY1")); assert.ok(!JSON.stringify(r).includes("69a6de70"));
    assert.ok(m.calls.some((c) => /^rm -rf .*jobs\/job1/.test(c.trim())), "job directory removed");
  } finally { await repo.cleanup(); }
});

test("temporary Mac-side copies are removed even when the source upload fails", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    const m = mac(repo, () => { throw new Error("must not run"); });
    const r = await runIosOperation(repo.root, d, { operation: "build-simulator" }, m.deps({ uploadSource: async () => { throw new Error("Remote upload failed: disk full"); } }));
    assert.equal(r.status, "failed"); assert.match(r.output!, /disk full/);
    assert.ok(m.calls.some((c) => c.includes("rm -rf") && c.includes("jobs/job1")));
    assert.equal(m.mainScripts.length, 0);
  } finally { await repo.cleanup(); }
});

test("archive: credentials are resolved on the Mac by name, redacted, and never embedded; success is verified against the project", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      const d = await discoverIosProject(repo.root);
      const archiveMarkers = { SUCCEEDED: "1", ARCHIVE: "1", CFBundleIdentifier: "com.acme.app", CFBundleShortVersionString: "1.2.0", CFBundleVersion: "7" };
      const m = mac(repo, () => reply(archiveMarkers, "** ARCHIVE SUCCEEDED **"));
      const r = await runIosOperation(repo.root, d, { operation: "archive" }, m.deps({ persist: true, settings: signing, state: stateWith() }));
      assert.equal(r.status, "success", r.summary); assert.equal(r.verified, true);
      assert.equal(r.outputs?.archivePath, ".agent-team-builder/releases/job1/App.xcarchive");
      assert.ok(r.context?.treeHash.length === 64);
      const script = m.mainScripts[0];
      for (const name of Object.values(KEY)) assert.ok(script.includes(`'${name}'`), name);
      assert.match(script, /find-generic-password -w -a 'asc-key-id'/);
      assert.match(script, /base64 -D/); assert.match(script, /chmod 600/); assert.match(script, /trap 'rm -rf "\$KEYDIR"/);
      assert.match(script, /perl -0pe 's\/\\Q\$ENV\{ASC_KEY_ID\}\\E\/\[redacted\]\/g'/);
      assert.doesNotMatch(script, /BEGIN PRIVATE KEY|--password|-w [A-Za-z0-9+/]{30}/);
      assert.match(script, /DEVELOPMENT_TEAM=ABCDE12345/);
      const state = await readIosState(repo.root);
      assert.equal(state.lastArchive?.archivePath, r.outputs?.archivePath);
      assert.equal(state.lastArchive?.treeHash, r.context?.treeHash);
      assert.equal(state.steps.archive?.status, "passed");
      const mismatch = mac(repo, () => reply({ ...archiveMarkers, CFBundleVersion: "99" }, "** ARCHIVE SUCCEEDED **"));
      const bad = await runIosOperation(repo.root, d, { operation: "archive" }, mismatch.deps({ settings: signing, state: stateWith() }));
      assert.equal(bad.status, "failed"); assert.match(bad.summary, /build 99 ≠ 7/);
      const missing = mac(repo, () => reply({ SUCCEEDED: "1" }, "** ARCHIVE SUCCEEDED **"));
      assert.equal((await runIosOperation(repo.root, d, { operation: "archive" }, missing.deps({ settings: signing, state: stateWith() }))).failureClass, "verification");
    });
  } finally { await repo.cleanup(); }
});

test("export requires an archive from the current tree, produces an export-only plist, and verifies the ipa", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    const ctx = await captureRunContext(repo.root);
    const m = mac(repo, () => reply({ SUCCEEDED: "1", IPA: ".agent-team-builder/releases/arch1/export/Acme.ipa" }, "** EXPORT SUCCEEDED **"));
    const none = await runIosOperation(repo.root, d, { operation: "export" }, m.deps({ settings: signing, state: stateWith() }));
    assert.equal(none.status, "blocked"); assert.match(none.summary, /no verified archive/);
    const stale = await runIosOperation(repo.root, d, { operation: "export" }, m.deps({ settings: signing, state: stateWith({ lastArchive: { archivePath: "a", treeHash: "old", at: "", id: "arch1" } }) }));
    assert.equal(stale.status, "blocked"); assert.match(stale.summary, /earlier version/);
    const r = await runIosOperation(repo.root, d, { operation: "export" }, m.deps({ settings: signing, state: stateWith({ lastArchive: { archivePath: "a", treeHash: ctx.treeHash, at: "", id: "arch1" } }) }));
    assert.equal(r.status, "success", r.summary);
    assert.equal(r.outputs?.ipaPath, ".agent-team-builder/releases/arch1/export/Acme.ipa");
    const script = m.mainScripts.at(-1)!;
    assert.match(script, /<key>destination<\/key><string>export<\/string>/); assert.match(script, /<key>teamID<\/key><string>ABCDE12345/);
    assert.match(script, /-exportArchive/); assert.doesNotMatch(script, /--upload-app/);
    const noIpa = mac(repo, () => reply({ SUCCEEDED: "1" }, "** EXPORT SUCCEEDED **"));
    assert.equal((await runIosOperation(repo.root, d, { operation: "export" }, noIpa.deps({ settings: signing, state: stateWith({ lastArchive: { archivePath: "a", treeHash: ctx.treeHash, at: "", id: "arch1" } }) }))).failureClass, "verification");
  } finally { await repo.cleanup(); }
});

test("upload: separate permission, duplicate-build guard, verified success, never submits for review", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      const d = await discoverIosProject(repo.root);
      const ctx = await captureRunContext(repo.root);
      const exportRecord = { ipaPath: ".agent-team-builder/releases/arch1/export/Acme.ipa", exportPath: "x", treeHash: ctx.treeHash, at: "", id: "arch1" };
      const settings = { permissions: { signing: true, upload: true }, apiKey: KEY };
      const m = mac(repo, () => reply({ UPLOAD_OK: "1", DELIVERY: "d3adb33f-aaaa-bbbb-cccc-1234567890ab" }, "UPLOAD SUCCEEDED with no errors\nDelivery UUID: d3adb33f-aaaa-bbbb-cccc-1234567890ab"));
      const dup = await runIosOperation(repo.root, d, { operation: "upload" }, m.deps({ settings, state: stateWith({ lastExport: exportRecord, lastUpload: { marketingVersion: "1.2.0", buildNumber: "7", at: "" } }) }));
      assert.equal(dup.failureClass, "duplicate-build"); assert.match(dup.remedy!, /Increment the build number/);
      assert.equal(m.mainScripts.length, 0);
      const r = await runIosOperation(repo.root, d, { operation: "upload" }, m.deps({ persist: true, settings, state: stateWith({ lastExport: exportRecord }) }));
      assert.equal(r.status, "success", r.summary); assert.equal(r.verified, true);
      assert.equal(r.outputs?.uploadId, "d3adb33f-aaaa-bbbb-cccc-1234567890ab");
      assert.match(r.summary, /NOT been submitted for review/); assert.match(r.summary, /cannot be queried/);
      assert.match(m.mainScripts[0], /altool' '--upload-app' '-f' "\$HOME"\/'\.agent-team-builder\/releases\/arch1\/export\/Acme\.ipa'/);
      assert.equal((await readIosState(repo.root)).lastUpload?.buildNumber, "7");
      const validate = await runIosOperation(repo.root, d, { operation: "upload", validateOnly: true }, m.deps({ settings, state: stateWith({ lastExport: exportRecord, lastUpload: { marketingVersion: "1.2.0", buildNumber: "7", at: "" } }) }));
      assert.equal(validate.status, "success"); assert.match(validate.summary, /Nothing was uploaded/);
      const noText = mac(repo, () => reply({}, "uploading..."));
      assert.equal((await runIosOperation(repo.root, d, { operation: "upload" }, noText.deps({ settings, state: stateWith({ lastExport: exportRecord }) }))).failureClass, "verification");
      const denied = mac(repo, () => reply({}, "Authentication failed: invalid issuer", 1));
      const authFail = await runIosOperation(repo.root, d, { operation: "upload" }, denied.deps({ settings, state: stateWith({ lastExport: exportRecord }) }));
      assert.equal(authFail.failureClass, "authentication"); assert.match(authFail.remedy!, /API key was rejected/);
      const missingSecret = { code: 23, output: "Mac Build Keychain secret 'asc-key-id' is unavailable.\n" };
      const nokey = mac(repo, () => missingSecret);
      const r3 = await runIosOperation(repo.root, d, { operation: "upload" }, nokey.deps({ settings, state: stateWith({ lastExport: exportRecord }) }));
      assert.equal(r3.failureClass, "credentials-missing");
    });
  } finally { await repo.cleanup(); }
});

test("simulator tests: success needs a readable summary with tests run; failures and empty runs are not success", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    const summary = (value: unknown) => ({ "xcresulttool get test-results summary": () => ({ code: 0, output: JSON.stringify(value) }) });
    const markers = { SUCCEEDED: "1", XCRESULT: "1" };
    const ok = mac(repo, () => reply(markers, "** TEST SUCCEEDED **"), summary({ passedTests: 12, failedTests: 0, skippedTests: 1, totalTestCount: 13 }));
    const r = await runIosOperation(repo.root, d, { operation: "test-simulator", testScope: "unit" }, ok.deps());
    assert.equal(r.status, "success", r.summary); assert.equal(r.testSummary?.total, 13);
    assert.match(ok.mainScripts[0], /-only-testing:AcmeTests/); assert.match(ok.mainScripts[0], /platform=iOS Simulator,id=SIM-UDID-1/);
    const failing = mac(repo, () => reply({ XCRESULT: "1" }, "Test Case failed", 65), summary({ passedTests: 3, failedTests: 2, totalTestCount: 5 }));
    const f = await runIosOperation(repo.root, d, { operation: "test-simulator" }, failing.deps());
    assert.equal(f.status, "failed"); assert.equal(f.failureClass, "test-failure");
    const failedButExit0 = mac(repo, () => reply(markers, "** TEST SUCCEEDED **"), summary({ passedTests: 3, failedTests: 2, totalTestCount: 5 }));
    const f2 = await runIosOperation(repo.root, d, { operation: "test-simulator" }, failedButExit0.deps());
    assert.equal(f2.status, "failed"); assert.match(f2.summary, /2 of 5 tests failed/);
    const zero = mac(repo, () => reply(markers, "** TEST SUCCEEDED **"), summary({ passedTests: 0, failedTests: 0, totalTestCount: 0 }));
    assert.equal((await runIosOperation(repo.root, d, { operation: "test-simulator" }, zero.deps())).failureClass, "verification");
    const unreadable = mac(repo, () => reply(markers, "** TEST SUCCEEDED **"), { "xcresulttool get test-results summary": () => ({ code: 0, output: "" }) });
    assert.equal((await runIosOperation(repo.root, d, { operation: "test-simulator" }, unreadable.deps())).failureClass, "verification");
    const noSim = mac(repo, () => reply(markers), { "simctl list devices available --json": () => ({ code: 0, output: JSON.stringify({ devices: {} }) }) });
    const blocked = await runIosOperation(repo.root, d, { operation: "test-simulator" }, noSim.deps());
    assert.equal(blocked.status, "blocked"); assert.match(blocked.remedy!, /simulator runtime/);
  } finally { await repo.cleanup(); }
});

test("physical device: needs a connected iPhone, then verifies install and launch", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    const none = mac(repo, () => reply(), { "xctrace list devices": () => ({ code: 0, output: "MACOS\t15.1\n" }) });
    const blocked = await runIosOperation(repo.root, d, { operation: "install-device" }, none.deps({ settings: signing, state: stateWith() }));
    assert.equal(blocked.status, "blocked"); assert.match(blocked.summary, /No physical iPhone/); assert.match(blocked.remedy!, /physical iPhone/);
    const m = mac(repo, () => reply({ SUCCEEDED: "1", INSTALLED: "1", LAUNCHED: "1" }, "App installed\nLaunched application with com.acme.app bundle identifier."), { "xctrace list devices": () => ({ code: 0, output: PROBE_DEVICE }) });
    const ok = await runIosOperation(repo.root, d, { operation: "install-device" }, m.deps({ settings: signing, state: stateWith() }));
    assert.equal(ok.status, "success", ok.summary);
    assert.match(m.mainScripts[0], /devicectl' 'device' 'install' 'app' '--device' '00008110-001A2B3C4D5E6F78'/);
    assert.match(m.mainScripts[0], /process' 'launch'/);
    const half = mac(repo, () => reply({ SUCCEEDED: "1", INSTALLED: "1" }), { "xctrace list devices": () => ({ code: 0, output: PROBE_DEVICE }) });
    assert.equal((await runIosOperation(repo.root, d, { operation: "install-device" }, half.deps({ settings: signing, state: stateWith() }))).failureClass, "verification");
  } finally { await repo.cleanup(); }
});

test("repository secret mappings are exported from the Keychain by name and redacted in output", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    const m = mac(repo, () => reply({ SUCCEEDED: "1", APP: "1" }, "** BUILD SUCCEEDED **"));
    await runIosOperation(repo.root, d, { operation: "build-simulator" }, m.deps({ project: { setupCommand: "pod install", secrets: { API_BASE: "backend-base-url" } } }));
    const script = m.mainScripts[0];
    assert.match(script, /export API_BASE="\$\(\/usr\/bin\/security find-generic-password -w -a 'backend-base-url'/);
    assert.match(script, /perl -0pe 's\/\\Q\$ENV\{API_BASE\}\\E\/\[redacted\]\/g'/);
    assert.match(script, /pod install/);
  } finally { await repo.cleanup(); }
});

test("exact worktree context is recorded for every persisted run", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      const d = await discoverIosProject(repo.root);
      const m = mac(repo, () => reply({ SUCCEEDED: "1", APP: "1" }, "** BUILD SUCCEEDED **"));
      const r = await runIosOperation(repo.root, d, { operation: "build-simulator" }, m.deps({ persist: true }));
      assert.equal(r.context?.root, repo.root); assert.equal(r.context?.dirty, true);
      assert.match(r.context!.commit!, /^[0-9a-f]{40}$/);
      const record = await readIosState(repo.root);
      assert.equal(record.steps["build-simulator"]?.treeHash, r.context?.treeHash);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(`${repo.root}/Acme/New.swift`, "// changed\n");
      assert.notEqual((await captureRunContext(repo.root)).treeHash, r.context?.treeHash);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(`${repo.root}/release`, { recursive: true });
      const withCode = (await captureRunContext(repo.root)).treeHash;
      await writeFile(`${repo.root}/release/notes.md`, "metadata only\n");
      assert.equal((await captureRunContext(repo.root)).treeHash, withCode, "release metadata does not change code identity");
    });
  } finally { await repo.cleanup(); }
});

test("every generated Mac script is syntactically valid shell", async () => {
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("bash", ["-c", "true"]).status !== 0) return;
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    const ctx = await captureRunContext(repo.root);
    const state = stateWith({ lastArchive: { archivePath: "a", treeHash: ctx.treeHash, at: "", id: "arch1" }, lastExport: { ipaPath: ".agent-team-builder/releases/arch1/export/A.ipa", exportPath: "x", treeHash: ctx.treeHash, at: "", id: "arch1" } });
    const settings = { permissions: { signing: true, upload: true }, apiKey: KEY };
    const m = mac(repo, () => reply({}), { "xctrace list devices": () => ({ code: 0, output: PROBE_DEVICE }) });
    const project = { setupCommand: "bundle exec pod install", secrets: { API_BASE: "backend-base-url" } };
    for (const operation of ["generate-project", "build-simulator", "test-simulator", "build-release", "install-device", "archive", "export", "upload"] as const)
      await runIosOperation(repo.root, d, { operation }, m.deps({ settings, state, project }));
    assert.equal(m.mainScripts.length, 8);
    for (const script of m.mainScripts) {
      const check = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      assert.equal(check.status, 0, check.stderr + "\n" + script.slice(0, 400));
    }
  } finally { await repo.cleanup(); }
});
