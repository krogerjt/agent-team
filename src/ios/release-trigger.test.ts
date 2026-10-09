import assert from "node:assert/strict";
import { test } from "node:test";
import { goalMentionsRelease, isIosApp, releaseStageEnabled, shouldRunReleaseStage } from "./release-trigger.js";
import { healthyApp, iosRepo, pbxproj } from "./test-helpers.js";

test("goals about releasing the app trigger the stage; goals that merely contain the word do not", () => {
  const yes = [
    "Add dark mode and get the app ready for the App Store",
    "Prepare this for TestFlight",
    "ship the app to the app-store",
    "Submit it for App Review once the tests pass",
    "Fix the crash, then release build 1.0.1",
    "Make it ready for release",
    "archive and upload the build",
    "Publish the app to the store",
    "release this to production",
  ];
  const no = [
    "Add a release notes screen to the app",
    "Show the release date of each card",
    "Refactor the store layer",
    "Fix the shipping address form",
    "Add an upload button for profile photos",
    "Write release notes in the changelog",
    "Rename the archive view",
    "Improve app performance",
  ];
  for (const goal of yes) assert.equal(goalMentionsRelease(goal), true, goal);
  for (const goal of no) assert.equal(goalMentionsRelease(goal), false, goal);
});

test("only iOS applications count: XcodeGen and pbxproj apps yes; non-iOS, library-only and non-Apple repos no", async () => {
  const xcodegen = await iosRepo(healthyApp());
  const raw = await iosRepo({ "PbxApp.xcodeproj/project.pbxproj": pbxproj() });
  const mac = await iosRepo({ "project.yml": "name: M\ntargets:\n  M:\n    type: application\n    platform: macOS\n" });
  const lib = await iosRepo({ "project.yml": "name: L\ntargets:\n  L:\n    type: framework\n    platform: iOS\n" });
  const web = await iosRepo({ "package.json": "{}", "index.html": "<html/>" });
  try {
    assert.equal(await isIosApp(xcodegen.root), true);
    assert.equal(await isIosApp(raw.root), true);
    assert.equal(await isIosApp(mac.root), false);
    assert.equal(await isIosApp(lib.root), false);
    assert.equal(await isIosApp(web.root), false);
    assert.equal(await isIosApp("C:/this/path/does/not/exist"), false);
  } finally { await Promise.all([xcodegen, raw, mac, lib, web].map((repo) => repo.cleanup())); }
});

test("the stage needs the goal AND an iOS app, and can be switched off", async () => {
  const app = await iosRepo(healthyApp());
  const web = await iosRepo({ "package.json": "{}" });
  try {
    assert.equal(await shouldRunReleaseStage("Ship the app to the App Store", app.root, {}), true);
    assert.equal(await shouldRunReleaseStage("Add a settings screen", app.root, {}), false, "an iOS app without a release goal");
    assert.equal(await shouldRunReleaseStage("Ship the app to the App Store", web.root, {}), false, "a release goal on a non-iOS repository");
    assert.equal(await shouldRunReleaseStage("Ship the app to the App Store", app.root, { AGENT_TEAM_RELEASE_STAGE: "off" }), false);
    assert.equal(releaseStageEnabled({ AGENT_TEAM_RELEASE_STAGE: " OFF " }), false); assert.equal(releaseStageEnabled({}), true);
  } finally { await app.cleanup(); await web.cleanup(); }
});
