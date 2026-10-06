import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { runRemoteChecks } from "./executor.js";
import { readRemoteBuildHost, readRemoteProjectSettings, saveRemoteBuildHost, saveRemoteProjectSettings, suggestedSetupCommand, validateRemoteBuildHost } from "./settings.js";

const cleanup: string[] = [];
after(async () => { for (const folder of cleanup) await rm(folder, { recursive: true, force: true }); });

test("persists a global Mac host and repository-specific setup without secrets in the host file", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-team-remote-settings-")); cleanup.push(data);
  const previous = process.env.AGENT_TEAM_DATA_DIR; process.env.AGENT_TEAM_DATA_DIR = data;
  try {
    const repo = path.join(data, "repo"); await mkdir(repo);
    const host = await saveRemoteBuildHost({ enabled: true, target: "builder@mac.local", port: 2222, root: ".agent-team-builder" });
    assert.deepEqual(await readRemoteBuildHost(), host);
    const project = await saveRemoteProjectSettings(repo, { setupCommand: "bundle exec pod install", secrets: { API_TOKEN: "ios/api-token" } });
    assert.deepEqual(await readRemoteProjectSettings(repo), project);
    assert.doesNotMatch(await readFile(path.join(data, "remote-build-host.json"), "utf8"), /api-token/i);
  } finally { if (previous === undefined) delete process.env.AGENT_TEAM_DATA_DIR; else process.env.AGENT_TEAM_DATA_DIR = previous; }
});

test("validates SSH inputs and suggests CocoaPods setup", async () => {
  assert.throws(() => validateRemoteBuildHost({ enabled: true, target: "-oProxyCommand=bad", root: ".agent-team-builder" }), /SSH alias/);
  assert.throws(() => validateRemoteBuildHost({ enabled: true, target: "mac", root: "../escape" }), /inside/);
  const repo = await mkdtemp(path.join(os.tmpdir(), "agent-team-pod-")); cleanup.push(repo);
  await writeFile(path.join(repo, "Podfile"), "platform :ios\n");
  assert.equal(await suggestedSetupCommand(repo), "pod install");
  await writeFile(path.join(repo, "Gemfile"), "gem 'cocoapods'\n");
  assert.equal(await suggestedSetupCommand(repo), "bundle exec pod install");
});

test("marks Apple checks as required when no Mac host is enabled", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-team-remote-disabled-")); cleanup.push(data);
  const previous = process.env.AGENT_TEAM_DATA_DIR; process.env.AGENT_TEAM_DATA_DIR = data;
  try {
    const [result] = await runRemoteChecks(process.cwd(), [{ name: "Xcode tests", executable: "xcodebuild", args: ["test"], platform: "darwin" }]);
    assert.equal(result.status, "missing");
    assert.equal(result.required, true);
    assert.match(result.output, /Mac Build Host/);
  } finally { if (previous === undefined) delete process.env.AGENT_TEAM_DATA_DIR; else process.env.AGENT_TEAM_DATA_DIR = previous; }
});
