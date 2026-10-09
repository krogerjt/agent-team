import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import * as cmd from "./commands.js";
import { pngInfo } from "./discovery.js";
import { runIosOperation } from "./operations.js";
import { discoverIosProject } from "./discovery.js";
import { collectScreenshots, humanName } from "./screenshots.js";
import { runsDir } from "./store.js";
import { baseDeps, healthyApp, iosRepo, withData } from "./test-helpers.js";

async function fakeAttachments(repoRoot: string, items: Array<{ file: string; human: string; width: number; height: number; alpha: boolean }>): Promise<string> {
  const dir = path.join(runsDir(repoRoot), "artifacts", "run1", "attachments");
  await mkdir(dir, { recursive: true });
  const manifest = [{ testIdentifier: "ScreenshotTests/testCapture()", attachments: items.map((item) => ({ exportedFileName: item.file, suggestedHumanReadableName: item.human })) }];
  for (const item of items) {
    const image = sharp({ create: { width: item.width, height: item.height, channels: item.alpha ? 4 : 3, background: item.alpha ? { r: 10, g: 20, b: 30, alpha: 0.5 } : { r: 10, g: 20, b: 30 } } });
    await writeFile(path.join(dir, item.file), await image.png().toBuffer());
  }
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

test("Xcode attachment names are cleaned up", () => {
  assert.equal(humanName("01-decks_0_6F2C1A3B-1111-2222-3333-444455556666.png"), "01-decks");
  assert.equal(humanName("weird name!_1_6F2C1A3B-1111-2222-3333-444455556666.png"), "weird-name-");
  assert.equal(humanName("plain.png"), "plain");
});

test("screenshots are collected as opaque, correctly sized PNGs in the right class folder; others are reported", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      await fakeAttachments(repo.root, [
        { file: "A.png", human: "02-cards_0_6F2C1A3B-1111-2222-3333-444455556666.png", width: 1320, height: 2868, alpha: true },
        { file: "B.png", human: "01-decks_0_6F2C1A3B-1111-2222-3333-444455556667.png", width: 1320, height: 2868, alpha: false },
        { file: "C.png", human: "03-small_0_6F2C1A3B-1111-2222-3333-444455556668.png", width: 1000, height: 2000, alpha: false },
        { file: "D.png", human: "04-medium_0_6F2C1A3B-1111-2222-3333-444455556669.png", width: 1206, height: 2622, alpha: true },
      ]);
      const dry = await collectScreenshots(repo.root, repo.root, { dryRun: true });
      assert.equal(dry.collected.filter((c) => c.target).length, 3);
      await assert.rejects(() => readFile(path.join(repo.root, "release/screenshots/iphone-6.9/01-decks.png")));
      const result = await collectScreenshots(repo.root, repo.root, { dryRun: false });
      assert.deepEqual(result.collected.map((c) => c.name), ["01-decks", "02-cards", "03-small", "04-medium"]);
      const skipped = result.collected.find((c) => c.name === "03-small")!;
      assert.match(skipped.skipped!, /1000×2000 is not an accepted/);
      const medium = result.collected.find((c) => c.name === "04-medium")!;
      assert.equal(medium.screenshotClass, "iphone-6.3");
      assert.deepEqual(pngInfo(await readFile(path.join(repo.root, "release/screenshots/iphone-6.3/04-medium.png"))), { width: 1206, height: 2622, alpha: false });
      for (const name of ["01-decks", "02-cards"]) {
        const info = pngInfo(await readFile(path.join(repo.root, `release/screenshots/iphone-6.9/${name}.png`)));
        assert.deepEqual(info, { width: 1320, height: 2868, alpha: false });
      }
      assert.match(result.message, /Wrote 3 screenshot/);
    });
  } finally { await repo.cleanup(); }
});

test("no attachments gives an actionable message", async () => {
  const repo = await iosRepo(healthyApp());
  try { await withData(repo, async () => assert.match((await collectScreenshots(repo.root, repo.root, { dryRun: true })).message, /No downloaded UI-test attachments/)); } finally { await repo.cleanup(); }
});

test("named simulator selection and the screenshot environment", () => {
  const sim = JSON.stringify({ devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [{ name: "iPhone 16 Pro Max", udid: "OLD", isAvailable: true, state: "Shutdown" }],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [{ name: "iPhone 17 Pro Max", udid: "NEW", isAvailable: true, state: "Shutdown" }, { name: "iPhone 17 Pro", udid: "PRO", isAvailable: true, state: "Booted" }] } });
  assert.equal(cmd.pickSimulator(sim, "iPhone 17 Pro Max"), "platform=iOS Simulator,id=NEW");
  assert.equal(cmd.pickSimulator(sim, "iPhone 16 Pro Max"), "platform=iOS Simulator,id=OLD");
  assert.equal(cmd.pickSimulator(sim, "iPhone 99"), undefined);
  assert.equal(cmd.pickSimulator(sim), "platform=iOS Simulator,id=PRO");
  const container: cmd.Container = { flag: "-project", file: "A.xcodeproj" };
  const on = cmd.simulatorTest(container, "A", "dest", "r", "c", ["UITests"], true);
  assert.match(cmd.renderCommand(on), /^env TEST_RUNNER_CAPTURE_SCREENSHOTS=1 'xcodebuild'/);
  assert.doesNotMatch(cmd.renderCommand(cmd.simulatorTest(container, "A", "dest", "r", "c")), /TEST_RUNNER/);
  assert.throws(() => cmd.renderCommand({ label: "x", argv: ["true"], timeoutMs: 1, env: { "bad name": "1" } }), /Invalid command environment/);
});

test("captureScreenshots runs only the UI tests on the named simulator with capture enabled, and keeps the manifest", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    const d = await discoverIosProject(repo.root);
    const scripts: string[] = [];
    const downloads: unknown[] = [];
    const sim = JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [{ name: "iPhone 17 Pro Max", udid: "MAX-UDID", isAvailable: true, state: "Shutdown" }] } });
    const run = async (_h: unknown, script: string) => {
      if (script.includes("@@NONCE:EXIT")) { scripts.push(script); return { code: 0, output: "** TEST SUCCEEDED **\n@@NONCE:EXIT=0\n@@NONCE:SUCCEEDED=1\n@@NONCE:XCRESULT=1\n" }; }
      if (script.includes("simctl list devices available --json")) return { code: 0, output: sim };
      if (script.includes("xcresulttool get test-results summary")) return { code: 0, output: JSON.stringify({ passedTests: 1, failedTests: 0, totalTestCount: 1 }) };
      return { code: 0, output: "" };
    };
    await withData(repo, async () => {
      const result = await runIosOperation(repo.root, d, { operation: "test-simulator", simulator: "iPhone 17 Pro Max", captureScreenshots: true }, baseDeps(repo, run as never, { persist: true, downloadAttachments: (async (...args: unknown[]) => { downloads.push(args[3]); }) as never }));
      assert.equal(result.status, "success", result.summary);
      assert.match(scripts[0], /env TEST_RUNNER_CAPTURE_SCREENSHOTS=1 'xcodebuild'/);
      assert.match(scripts[0], /-only-testing:AcmeUITests/); assert.doesNotMatch(scripts[0], /-only-testing:AcmeTests'/);
      assert.match(scripts[0], /platform=iOS Simulator,id=MAX-UDID/);
      assert.deepEqual(downloads[0], { includeManifest: true, maxBytes: 60 * 1024 * 1024 });
    });
    const missing = await runIosOperation(repo.root, d, { operation: "test-simulator", simulator: "iPhone 99" }, baseDeps(repo, run as never, { persist: false }));
    assert.equal(missing.status, "blocked"); assert.match(missing.summary, /named "iPhone 99"/);
    const bad = await runIosOperation(repo.root, d, { operation: "test-simulator", simulator: "x; rm -rf ~" }, baseDeps(repo, run as never, { persist: false }));
    assert.equal(bad.status, "blocked");
  } finally { await repo.cleanup(); }
});
