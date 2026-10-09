import assert from "node:assert/strict";
import { test } from "node:test";
import { git } from "../coding/git.js";
import type { ModelProvider, ToolCapableProvider, ToolRequest, ToolResponse } from "../core/provider.js";
import { healthyApp, iosRepo, withData, type IosRepo } from "../ios/test-helpers.js";
import { createRunState, saveState, type TeamRunState } from "./state.js";
import { formatReleaseSection, runReleaseStage, type TeamProviders } from "./workflow.js";

const RELEASE_GOAL = "Add a settings screen and get the app ready for the App Store";

async function runFor(repo: IosRepo, goal: string): Promise<TeamRunState> {
  await git(repo.root, ["add", "-A"]);
  await git(repo.root, ["commit", "-qm", "app", "--allow-empty"]);
  const state = await createRunState(repo.root, goal, await git(repo.root, ["rev-parse", "HEAD"]));
  state.staging = { path: repo.root, branch: "codex/team-test" };
  await saveState(state);
  return state;
}

function hollisProvider(reply: string, script?: (request: ToolRequest) => Promise<void>): ToolCapableProvider & { calls: number; offered: string[] } {
  const provider = {
    name: "hollis", calls: 0, offered: [] as string[],
    async generate() { return { text: "ok" }; },
    async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
      provider.calls++; provider.offered = request.tools.map((tool) => tool.name);
      await script?.(request);
      return { text: reply, toolCalls: 0 };
    },
  };
  return provider;
}
const providersWith = (hollis?: ModelProvider) => ({ hollis } as unknown as TeamProviders);

test("an iOS app with a release goal is handed to Hollis; he can verify and report but not edit or ship", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      const state = await runFor(repo, RELEASE_GOAL);
      const seen: Record<string, string> = {};
      const hollis = hollisProvider("RELEASE_NEEDS_INPUT: Build and tests verified.\n- Audit: 3 pending (screenshots, device test).\nNext: review, merge, then ask Hollis to archive.", async (request) => {
        seen.discover = JSON.parse((await request.execute("ios_discover_project", {})).content).facts.bundleId;
        for (const operation of ["archive", "export", "upload", "build-release", "install-device"]) seen[operation] = (await request.execute("ios_run_operation", { operation })).content;
        seen.edit = (await request.execute("apply_patch", { path: "x.md", oldText: "", newText: "y" })).content;
        seen.workspace = (await request.execute("ios_open_release_workspace", {})).content;
        seen.playbook = (await request.execute("ios_playbook", { topic: "signing-and-export" })).content;
      });
      await runReleaseStage(state, providersWith(hollis));
      assert.equal(hollis.calls, 1);
      assert.equal(state.release?.status, "needs-input");
      assert.match(state.release!.report, /^Build and tests verified\./);
      assert.doesNotMatch(state.release!.report, /RELEASE_NEEDS_INPUT/);
      assert.equal(seen.discover, "com.acme.app");
      for (const operation of ["archive", "export", "upload", "build-release", "install-device"]) assert.match(seen[operation], /readiness stage/, operation);
      assert.match(seen.edit, /readiness stage|Not available/); assert.match(seen.workspace, /readiness stage|Not available/);
      assert.match(seen.playbook, /ARCHIVE, EXPORT, UPLOAD/);
      for (const hidden of ["apply_patch", "create_png", "ios_open_release_workspace", "ios_commit_release_changes"]) assert.ok(!hollis.offered.includes(hidden), hidden);
      assert.ok(hollis.offered.includes("ios_run_operation") && hollis.offered.includes("ios_release_audit"));
      assert.equal(await git(repo.root, ["status", "--porcelain"]), "", "nothing was edited");
    });
  } finally { await repo.cleanup(); }
});

test("the first line of Hollis's reply decides the status", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      for (const [reply, expected] of [["RELEASE_READY: all verified", "ready"], ["release_blocked: mac offline", "blocked"], ["RELEASE_NEEDS_INPUT: add screenshots", "needs-input"], ["I looked around and things seem fine", "needs-input"]] as const) {
        const state = await runFor(repo, RELEASE_GOAL);
        await runReleaseStage(state, providersWith(hollisProvider(reply)));
        assert.equal(state.release?.status, expected, reply);
      }
    });
  } finally { await repo.cleanup(); }
});

test("no stage without both conditions, and no stage when switched off", async () => {
  const app = await iosRepo(healthyApp());
  const web = await iosRepo({ "package.json": "{}", "index.html": "<html/>" });
  const previous = process.env.AGENT_TEAM_RELEASE_STAGE;
  try {
    await withData(app, async () => {
      const hollis = hollisProvider("RELEASE_READY: x");
      const notRelease = await runFor(app, "Add a release notes screen to the app");
      await runReleaseStage(notRelease, providersWith(hollis)); assert.equal(notRelease.release, undefined);
      const notIos = await runFor(web, "Ship the app to the App Store");
      await runReleaseStage(notIos, providersWith(hollis)); assert.equal(notIos.release, undefined);
      process.env.AGENT_TEAM_RELEASE_STAGE = "off";
      const off = await runFor(app, RELEASE_GOAL);
      await runReleaseStage(off, providersWith(hollis)); assert.equal(off.release, undefined);
      assert.equal(hollis.calls, 0, "Hollis was never called");
    });
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAM_RELEASE_STAGE; else process.env.AGENT_TEAM_RELEASE_STAGE = previous;
    await app.cleanup(); await web.cleanup();
  }
});

test("a missing provider is skipped, a failing provider is reported without breaking the run, and the stage runs once", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      const skipped = await runFor(repo, RELEASE_GOAL);
      await runReleaseStage(skipped, providersWith(undefined));
      assert.equal(skipped.release?.status, "skipped"); assert.match(skipped.release!.report, /HOLLIS_PROVIDER/);

      const failing = await runFor(repo, RELEASE_GOAL);
      const broken: ToolCapableProvider = { name: "hollis", async generate() { return { text: "" }; }, async generateWithTools(): Promise<ToolResponse> { throw new Error("model service unavailable"); } };
      await runReleaseStage(failing, providersWith(broken));
      assert.equal(failing.release?.status, "failed"); assert.match(failing.release!.report, /model service unavailable/);

      const once = await runFor(repo, RELEASE_GOAL);
      const hollis = hollisProvider("RELEASE_READY: ok");
      await runReleaseStage(once, providersWith(hollis)); await runReleaseStage(once, providersWith(hollis));
      assert.equal(hollis.calls, 1);
    });
  } finally { await repo.cleanup(); }
});

test("the release section for the review summary is labelled in plain language", () => {
  assert.equal(formatReleaseSection({ status: "ready", report: "All good.\n", at: "t" }), "**Release readiness (Hollis): ready**\nAll good.");
  assert.match(formatReleaseSection({ status: "needs-input", report: "x", at: "t" }), /needs your input/);
  assert.match(formatReleaseSection({ status: "failed", report: "x", at: "t" }), /could not run/);
});
