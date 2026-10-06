import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkEnvironment, detectChecks, executeCheck, selectSimulatorDestination } from "./checks.js";
import { tempRepo } from "./test-helpers.js";

const cleanup: string[] = [];
after(async () => {
  for (const target of cleanup) {
    assert.equal(path.dirname(target), os.tmpdir());
    await rm(target, { recursive: true, force: true });
  }
});

test("detects Node, .NET, and Python checks without model commands", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push(parent);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", typecheck: "tsc --noEmit" } }));
  await writeFile(path.join(root, "service.sln"), "");
  await writeFile(path.join(root, "pyproject.toml"), "[tool.pytest.ini_options]\n");
  assert.deepEqual((await detectChecks(root)).map((check) => check.name), ["npm test", "npm run typecheck", "dotnet test", "python -m pytest"]);
});

test("does not pass API credentials to repository checks", () => {
  assert.deepEqual(checkEnvironment({ PATH: "bin", OPENAI_API_KEY: "private", ANTHROPIC_API_KEY: "private", AWS_SECRET_ACCESS_KEY: "private" }), { CI: "1", PATH: "bin" });
});

test("detects a shared iOS Xcode scheme and marks it as a macOS check", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push(parent);
  const project = path.join(root, "Example.xcodeproj");
  const scheme = path.join(project, "xcshareddata", "xcschemes");
  const internalWorkspace = path.join(project, "project.xcworkspace");
  await mkdir(scheme, { recursive: true });
  await mkdir(internalWorkspace, { recursive: true });
  await writeFile(path.join(project, "project.pbxproj"), "SDKROOT = iphoneos;\n");
  await writeFile(path.join(scheme, "Example.xcscheme"), "<Scheme/>\n");
  await writeFile(path.join(internalWorkspace, "contents.xcworkspacedata"), "<Workspace/>\n");
  const { git } = await import("./git.js");
  await git(root, ["add", "-A"]);
  const checks = await detectChecks(root);
  assert.deepEqual(checks, [{
    name: "xcodebuild Example (iOS Simulator)",
    executable: "xcodebuild",
    args: ["-project", "Example.xcodeproj", "-scheme", "Example", "-destination", "generic/platform=iOS Simulator", "build", "CODE_SIGNING_ALLOWED=NO"],
    platform: "darwin",
    timeoutMs: 600_000,
  }]);
});

test("reports platform-specific checks as unavailable without executing them", async () => {
  const result = await executeCheck(process.cwd(), { name: "foreign check", executable: "does-not-exist", args: [], platform: process.platform === "darwin" ? "win32" : "darwin" });
  assert.equal(result.status, "missing");
  assert.match(result.output, /requires/);
});

test("detects XcodeGen generation, simulator build and tests before an xcodeproj exists", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push(parent);
  await writeFile(path.join(root, "project.yml"), "name: Example\ntargets:\n  Example:\n    type: application\n    platform: iOS\nschemes:\n  Example:\n    build:\n      targets:\n        Example: all\n    test:\n      targets: [ExampleTests]\n");
  const checks = await detectChecks(root);
  assert.deepEqual(checks.map((check) => check.executable), ["xcodegen", "xcodebuild", "xcodebuild"]);
  assert.deepEqual(checks[0].args, ["generate", "--spec", "project.yml"]);
  assert.equal(checks[1].args[1], "Example.xcodeproj");
  assert.equal(checks[2].simulatorPlatform, "iOS");
  assert.ok(checks.every((check) => check.platform === "darwin"));
});

test("selects a booted simulator for the detected Apple platform", () => {
  const listing = JSON.stringify({ devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-4": [
      { name: "iPhone 16", udid: "available", isAvailable: true, state: "Shutdown" },
      { name: "iPhone 16 Pro", udid: "booted", isAvailable: true, state: "Booted" },
    ],
    "com.apple.CoreSimulator.SimRuntime.tvOS-18-4": [{ name: "Apple TV", udid: "tv", isAvailable: true, state: "Shutdown" }],
  } });
  assert.equal(selectSimulatorDestination(listing, "iOS"), "platform=iOS Simulator,id=booted");
  assert.equal(selectSimulatorDestination(listing, "tvOS"), "platform=tvOS Simulator,id=tv");
});
