import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelRequest, ToolCapableProvider, ToolRequest, ToolResponse } from "../core/provider.js";
import { roster } from "../personas/roster.js";
import { saveRemoteBuildHost } from "../remote/settings.js";
import { createRunState } from "../team/state.js";
import { messageTeamPersona } from "../team/workflow.js";
import { git } from "../coding/git.js";
import { executeIosTool, IOS_TOOL_NAMES, iosTools } from "./tools.js";
import { buildProgress, resumeBlockedSteps, satisfiedBlockers } from "./session.js";
import { redactDeep } from "./redact.js";
import { readIosState, saveIosSettings, setIosPermission, validateSettings } from "./store.js";
import { healthyApp, iosRepo, withData, type IosRepo } from "./test-helpers.js";

const GOOD_PROBE = [
  "MACOS\t15.1", "XCODE\tXcode 26.0.1 Build version 17A400 ", "CLT\t/Applications/Xcode.app/Contents/Developer", "XCODEBUILD\t/usr/bin/xcodebuild", "XCRUN\t/usr/bin/xcrun",
  "XCODEGEN\t/opt/homebrew/bin/xcodegen", "ALTOOL\t/x/altool", "RUNTIMES\t1", "SIMULATORS\t6", "IDENTITIES\t\"Apple Distribution: Acme (ABCDE12345)\";", "PROFILES\t1", "DISK\t52428800", "KEYCHAIN\tunlocked",
].join("\n");
const fakeMac = async (_host: unknown, script: string) => ({ code: 0, output: script.includes("security dump-keychain") ? "KEYCHAIN\tunlocked\n" : GOOD_PROBE });
const json = (result: { content: string }) => JSON.parse(result.content);
const ctx = (repo: IosRepo, extra: Record<string, unknown> = {}) => ({ root: repo.root, repo: repo.root, writable: false, run: fakeMac as never, ...extra });

test("the agent tool surface is typed, has no shell access, and cannot grant permissions or submit", () => {
  const tools = iosTools();
  assert.deepEqual(IOS_TOOL_NAMES.sort(), ["ios_check_readiness", "ios_discover_project", "ios_mac_maintenance", "ios_playbook", "ios_prepare_release", "ios_recent_runs", "ios_release_audit", "ios_release_preflight", "ios_release_status", "ios_run_operation", "ios_screenshot_requirements"]);
  for (const tool of tools) {
    const properties = Object.keys((tool.parameters as { properties: object }).properties);
    assert.ok(!properties.some((name) => /command|shell|script|args|path|secret|password|key/i.test(name)), `${tool.name}: ${properties.join(",")}`);
    assert.equal((tool.parameters as { additionalProperties: boolean }).additionalProperties, false);
    assert.ok(!/grant|submit_for_review/.test(tool.name));
  }
  const operation = tools.find((tool) => tool.name === "ios_run_operation")!.parameters as { properties: { operation: { enum: string[] } } };
  assert.ok(!operation.properties.operation.enum.some((name) => /submit|review/.test(name)));
  assert.match(tools.find((tool) => tool.name === "ios_run_operation")!.description, /never submits for App Review/);
  assert.match(roster.hollis.systemPrompt, /never submit for App Review/i);
  assert.match(roster.hollis.systemPrompt, /verified=true/);
});

test("discovery, audit and screenshot tools return structured results and record progress", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      const discovered = json(await executeIosTool("ios_discover_project", {}, ctx(repo)));
      assert.equal(discovered.facts.bundleId, "com.acme.app");
      assert.deepEqual(discovered.blockers, []);
      const audit = json(await executeIosTool("ios_release_audit", {}, ctx(repo)));
      assert.ok(audit.counts.pending > 0); assert.ok(Array.isArray(audit.findings)); assert.match(audit.report, /PENDING/);
      assert.equal(json(await executeIosTool("ios_screenshot_requirements", {}, ctx(repo))).classes[0].id, "iphone-6.9");
      const state = await readIosState(repo.root);
      assert.equal(state.steps.discover?.status, "passed"); assert.equal(state.steps.audit?.status, "passed");
      await assert.rejects(() => executeIosTool("run_checks", {}, ctx(repo)), /not available/);
    });
  } finally { await repo.cleanup(); }
});

test("release preparation is dry-run by default and only writes in a writable worktree when asked", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      const read = async () => readFile(path.join(repo.root, "project.yml"), "utf8");
      const dry = json(await executeIosTool("ios_prepare_release", { action: "increment-build" }, ctx(repo, { writable: true })));
      assert.equal(dry.applied, false); assert.match(await read(), /CURRENT_PROJECT_VERSION: "7"/);
      const readOnly = json(await executeIosTool("ios_prepare_release", { action: "increment-build", dryRun: false }, ctx(repo)));
      assert.equal(readOnly.applied, false); assert.match(readOnly.note, /Read-only/); assert.match(await read(), /"7"/);
      const written = json(await executeIosTool("ios_prepare_release", { action: "increment-build", dryRun: false }, ctx(repo, { writable: true })));
      assert.equal(written.applied, true); assert.match(await read(), /CURRENT_PROJECT_VERSION: "8"/);
      assert.equal((await readIosState(repo.root)).steps.prepare?.status, "passed");
      const templates = json(await executeIosTool("ios_prepare_release", { action: "generate-templates" }, ctx(repo, { writable: true })));
      assert.equal(templates.dryRun, true); assert.ok(templates.created.length > 0);
      await executeIosTool("ios_prepare_release", { action: "generate-templates", dryRun: false }, ctx(repo, { writable: true }));
      const files = json(await executeIosTool("ios_prepare_release", { action: "validate-files" }, ctx(repo)));
      assert.equal(files.ok, false); assert.ok(files.findings.every((f: { status: string }) => f.status === "pending"));
      assert.match(json(await executeIosTool("ios_prepare_release", { action: "checklist" }, ctx(repo))).checklist, /Submit for Review yourself/);
    });
  } finally { await repo.cleanup(); }
});

test("run_operation without a host or permission is blocked with the exact next step, never run", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      const noHost = await executeIosTool("ios_run_operation", { operation: "build-simulator" }, ctx(repo));
      assert.equal(noHost.isError, true); assert.match(json(noHost).remedy, /Mac Build Host/);
      await saveRemoteBuildHost({ enabled: true, target: "build-mac", root: ".agent-team-builder" });
      const noPermission = json(await executeIosTool("ios_run_operation", { operation: "archive" }, ctx(repo)));
      assert.equal(noPermission.status, "blocked"); assert.equal(noPermission.failureClass, "permission-denied");
      const preflight = json(await executeIosTool("ios_release_preflight", {}, ctx(repo)));
      assert.match(preflight.mode, /nothing signed/);
      assert.deepEqual(preflight.plans.map((plan: { status: string }) => plan.status), ["blocked", "blocked", "blocked"]);
      await assert.rejects(() => executeIosTool("ios_run_operation", { operation: "submit-for-review" }, ctx(repo)), /Unknown operation/);
    });
  } finally { await repo.cleanup(); }
});

test("readiness tool reports Mac state through the shared host checks and records it", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      assert.equal(json(await executeIosTool("ios_check_readiness", {}, ctx(repo))).counts.blocked, 1);
      await saveRemoteBuildHost({ enabled: true, target: "build-mac", root: ".agent-team-builder" });
      const ready = json(await executeIosTool("ios_check_readiness", {}, ctx(repo)));
      assert.equal(ready.ok, true, ready.report);
      assert.equal((await readIosState(repo.root)).steps.readiness?.status, "passed");
    });
  } finally { await repo.cleanup(); }
});

test("resume after a blocker: the user fixes it, recheck unblocks only that step, and progress continues", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      await saveRemoteBuildHost({ enabled: true, target: "build-mac", root: ".agent-team-builder" });
      const blocked = json(await executeIosTool("ios_run_operation", { operation: "archive" }, ctx(repo)));
      assert.equal(blocked.status, "blocked");
      let status = json(await executeIosTool("ios_release_status", {}, ctx(repo)));
      assert.equal(status.blocked[0].step, "archive"); assert.equal(status.blocked[0].blockers[0].id, "permission-signing");
      assert.equal(status.steps.find((s: { step: string }) => s.step === "archive").status, "blocked");
      status = json(await executeIosTool("ios_release_status", { recheck: true }, ctx(repo)));
      assert.deepEqual(status.unblocked, [], "still blocked until the user acts");
      await setIosPermission(repo.root, "signing", true); // the user, not the agent
      status = json(await executeIosTool("ios_release_status", { recheck: true }, ctx(repo)));
      assert.deepEqual(status.unblocked, ["archive"]);
      const archive = status.steps.find((s: { step: string }) => s.step === "archive");
      assert.equal(archive.status, "pending"); assert.match(archive.summary, /Unblocked/);
      assert.equal(status.steps.find((s: { step: string }) => s.step === "submit").status, "manual");
    });
  } finally { await repo.cleanup(); }
});

test("tool output with API-key command lines is valid JSON, keeps $VAR references, and still hides real secrets", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      await saveRemoteBuildHost({ enabled: true, target: "build-mac", root: ".agent-team-builder" });
      await saveIosSettings(repo.root, { apiKey: { keyIdSecret: "asc-key-id", issuerIdSecret: "asc-issuer-id", privateKeySecret: "asc-p8" } });
      await setIosPermission(repo.root, "signing", true); await setIosPermission(repo.root, "upload", true);
      const archive = await executeIosTool("ios_run_operation", { operation: "archive", dryRun: true }, ctx(repo));
      const parsed = JSON.parse(archive.content); // the original bug made this throw
      assert.equal(parsed.status, "dry-run");
      assert.match(parsed.commands.join(" "), /-authenticationKeyID \$ASC_KEY_ID/);
      assert.doesNotMatch(archive.content, /\[redacted\]/);
      const scrubbed = JSON.stringify(redactDeep({ output: "altool --apiKey ABC123DEF4 --apiIssuer 69a6de70-03db-47e3-e053-5b8c7c11a4d1 password=hunter22", list: ["token: abc.def"] }));
      assert.doesNotThrow(() => JSON.parse(scrubbed));
      for (const secret of ["ABC123DEF4", "69a6de70", "hunter22"]) assert.ok(!scrubbed.includes(secret), secret);
    });
  } finally { await repo.cleanup(); }
});

test("progress view: order, stale archives, optional steps, and the manual submission step", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const steps = {
    discover: { step: "discover", status: "passed", at, summary: "ok" }, readiness: { step: "readiness", status: "passed", at, summary: "ok" },
    "build-simulator": { step: "build-simulator", status: "passed", at, summary: "ok" }, "test-simulator": { step: "test-simulator", status: "passed", at, summary: "ok" },
    audit: { step: "audit", status: "passed", at, summary: "ok" }, archive: { step: "archive", status: "passed", at, summary: "archived", treeHash: "old" },
  } as never;
  const fresh = buildProgress({ steps }, "old");
  assert.equal(fresh.next, "export");
  const stale = buildProgress({ steps }, "new");
  assert.equal(stale.steps.find((s) => s.step === "archive")?.status, "stale");
  assert.equal(stale.next, "archive");
  assert.match(stale.text, /Next: archive/);
  assert.equal(stale.steps.at(-1)?.status, "manual");
  assert.equal(buildProgress({ steps: {} }).next, "discover");
});

test("resumeBlockedSteps only clears steps whose blockers are all satisfied", () => {
  const steps = { archive: { step: "archive", status: "blocked", at: "", summary: "", blockers: [{ id: "permission-signing", remedy: "", kind: "user-input" }, { id: "team-id", remedy: "", kind: "user-input" }] } } as never;
  assert.deepEqual(resumeBlockedSteps(steps, new Set(["permission-signing"])), []);
  assert.deepEqual(resumeBlockedSteps(steps, new Set(["permission-signing", "team-id"])), ["archive"]);
  const satisfied = satisfiedBlockers([{ id: "xcode-version", title: "", status: "passed", detail: "" }, { id: "macos", title: "", status: "passed", detail: "" }], { permissions: { signing: true, upload: false }, teamId: "ABCDE12345" }, undefined, true);
  for (const id of ["permission-signing", "team-id", "host", "xcode-version"]) assert.ok(satisfied.has(id), id);
  assert.ok(!satisfied.has("permission-upload"));
});

test("settings accept secret NAMES only, validate ids, and cannot alter permissions", async () => {
  assert.throws(() => validateSettings({ teamId: "abc" }), /Team ID/);
  assert.throws(() => validateSettings({ apiKey: { keyIdSecret: "has space", issuerIdSecret: "ok", privateKeySecret: "ok" } }), /secret name/i);
  assert.throws(() => validateSettings({ scheme: "A; rm" }), /Scheme/);
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      await setIosPermission(repo.root, "upload", true);
      const saved = await saveIosSettings(repo.root, { teamId: "ABCDE12345", apiKey: { keyIdSecret: "asc-key-id", issuerIdSecret: "asc-issuer", privateKeySecret: "asc-p8" }, permissions: { signing: true, upload: false } } as never);
      assert.deepEqual(saved.permissions, { signing: false, upload: true });
      await assert.rejects(() => setIosPermission(repo.root, "submit" as never, true), /never automated/);
      const { repoHome } = await import("../team/state.js");
      const raw = await readFile(path.join(repoHome(repo.root), "ios-release.json"), "utf8");
      assert.ok(!/BEGIN|password/i.test(raw)); assert.match(raw, /asc-key-id/);
    });
  } finally { await repo.cleanup(); }
});

test("only Hollis receives the iOS tools in team chat, and they execute against the repository", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await git(repo.root, ["add", "-A"]);
    await git(repo.root, ["commit", "-qm", "ios app"]);
    await withData(repo, async () => {
      const state = await createRunState(repo.root, "Ship the app", await git(repo.root, ["rev-parse", "HEAD"]));
      const seen: Record<string, string[]> = {};
      const provider = (name: string): ToolCapableProvider => ({
        name,
        async generate(_request: ModelRequest) { return { text: "ok" }; },
        async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
          seen[name] = request.tools.map((tool) => tool.name);
          if (name === "hollis") {
            const result = await request.execute("ios_discover_project", {});
            return { text: `bundle=${JSON.parse(result.content).facts.bundleId}`, toolCalls: 1 };
          }
          return { text: "done", toolCalls: 0 };
        },
      });
      assert.equal(await messageTeamPersona(state.runDir, "hollis", "where are we?", provider("hollis")), "bundle=com.acme.app");
      await messageTeamPersona(state.runDir, "kit", "hi", provider("kit"));
      assert.ok(seen.hollis.includes("ios_run_operation") && seen.hollis.includes("ios_release_status"));
      assert.ok(!seen.kit.some((name) => name.startsWith("ios_") || name.startsWith("web_")));
      for (const extra of ["ios_playbook", "ios_open_release_workspace", "ios_commit_release_changes", "web_search", "web_fetch", "apply_patch"]) assert.ok(seen.hollis.includes(extra), extra);
    });
  } finally { await repo.cleanup(); }
});

test("through team chat Hollis can read the playbook, open a release workspace, edit and commit locally; the user's checkout stays untouched", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await git(repo.root, ["add", "-A"]);
    await git(repo.root, ["commit", "-qm", "ios app"]);
    await withData(repo, async () => {
      const state = await createRunState(repo.root, "Prepare the release", await git(repo.root, ["rev-parse", "HEAD"]));
      const steps: string[] = [];
      const hollis: ToolCapableProvider = {
        name: "hollis",
        async generate() { return { text: "ok" }; },
        async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
          const call = async (name: string, args: Record<string, unknown>) => { steps.push(name); return request.execute(name, args); };
          assert.match(JSON.parse((await call("ios_playbook", { topic: "troubleshooting" })).content).text, /Cloud signing permission error/);
          const refused = await call("apply_patch", { path: "RELEASE_NOTES.md", oldText: "", newText: "v1\n" });
          assert.equal(refused.isError, true);
          const opened = JSON.parse((await call("ios_open_release_workspace", {})).content);
          const patched = await call("apply_patch", { path: "RELEASE_NOTES.md", oldText: "", newText: "v1\n" });
          assert.notEqual(patched.isError, true, patched.content);
          const commit = JSON.parse((await call("ios_commit_release_changes", { message: "Add release notes" })).content);
          return { text: `branch=${opened.branch} committed=${commit.committed}`, toolCalls: steps.length };
        },
      };
      const reply = await messageTeamPersona(state.runDir, "hollis", "prepare the release notes", hollis);
      assert.match(reply, /branch=codex\/hollis-release-[a-z0-9]+ committed=true/);
      assert.deepEqual(steps, ["ios_playbook", "apply_patch", "ios_open_release_workspace", "apply_patch", "ios_commit_release_changes"]);
      assert.equal(await git(repo.root, ["status", "--porcelain"]), "", "the user's checkout is unchanged");
      assert.equal(await git(repo.root, ["rev-parse", "HEAD"]), state.baseCommit, "the user's branch did not move");
      assert.doesNotMatch(await git(repo.root, ["branch", "--show-current"]), /hollis/);
    });
  } finally { await repo.cleanup(); }
});
