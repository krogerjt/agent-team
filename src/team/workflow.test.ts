import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tempRepo } from "../coding/test-helpers.js";
import { git } from "../coding/git.js";
import type { ModelProvider, ModelRequest, ModelResponse, ToolRequest, ToolResponse, ToolResult } from "../core/provider.js";
import { repoHome, type TeamRunState } from "./state.js";
import { deleteTeamRun } from "./run-cleanup.js";
import { answerTeamRun, mergeTeamRun, messageTeamPersona, reviewTeamRun, runTeamGoal, type TeamProviders } from "./workflow.js";

const cleanup: Array<{ parent: string; home: string }> = [];
after(async () => {
  for (const item of cleanup) {
    assert.equal(path.dirname(item.parent), os.tmpdir());
    assert.equal(path.dirname(item.home), path.join(os.homedir(), ".agent-team", "repos"));
    await rm(item.parent, { recursive: true, force: true });
    await rm(item.home, { recursive: true, force: true });
  }
});

async function repo(): Promise<string> {
  const { root, parent } = await tempRepo();
  cleanup.push({ parent, home: repoHome(root) });
  return root;
}

type Act = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
/** What a scripted Marlow reads from his decision prompt: the task wall, the new events, and whether anything is running. */
interface View { prompt: string; tasks: Array<{ id: string; status: string; line: string }>; events: Array<{ kind: string; taskId?: string }>; idle: boolean }
type Policy = (view: View, act: Act) => Promise<void>;

function view(prompt: string): View {
  const happened = prompt.slice(prompt.indexOf("What happened since your last decision:"));
  return {
    prompt,
    tasks: [...prompt.matchAll(/^- (\S+) \[(\w+)\] .*$/gm)].map((match) => ({ id: match[1], status: match[2], line: match[0] })),
    events: [...happened.matchAll(/^\[([\w-]+)(?: task=(\S+))?\]/gm)].map((match) => ({ kind: match[1], taskId: match[2] })),
    idle: /Running now: nothing\. Waiting to start: nothing\./.test(prompt),
  };
}

/** Review and QA each finished task, integrate once both verdicts are in, finish when everything is integrated. */
const standard: Policy = async (seen, act) => {
  const integrated = new Set<string>();
  for (const item of seen.events) {
    const task = seen.tasks.find((entry) => entry.id === item.taskId);
    if (item.kind === "work-done" && task) {
      await act("request_review", { taskId: task.id, reviewer: /worker: Rowan/.test(task.line) ? "marlow" : "rowan" });
      await act("request_qa", { taskId: task.id });
    }
    if ((item.kind === "review-done" || item.kind === "qa-done") && task && /review \(/.test(task.line) && /QA: /.test(task.line) && !integrated.has(task.id)) {
      integrated.add(task.id);
      await act("integrate", { taskId: task.id, reason: "review and QA passed" });
    }
  }
  if (seen.idle && seen.tasks.length && seen.tasks.every((task) => task.status === "done")) await act("finish", { summary: "All tasks are integrated." });
};

interface Script {
  plan: unknown;
  marlow?: Policy;
  /** Worker behavior for kit, wren, rowan, juniper, piper and hollis; defaults to a reviewer/researcher reply. */
  work?: (name: string, request: ToolRequest) => Promise<ToolResponse | undefined>;
  review?: string;
  qa?: string;
  generate?: (name: string, request: ModelRequest) => Promise<ModelResponse | undefined>;
}

function team(script: Script): TeamProviders & { prompts: string[]; results: Array<{ name: string; result: ToolResult }>; calls: string[] } {
  const prompts: string[] = [];
  const results: Array<{ name: string; result: ToolResult }> = [];
  const calls: string[] = [];
  const fake = (name: string): ModelProvider & { generateWithTools(request: ToolRequest): Promise<ToolResponse> } => ({
    name,
    async generate(request: ModelRequest): Promise<ModelResponse> { return await script.generate?.(name, request) ?? { text: name === "tove" ? "Verified note wording." : "Ready for human review." }; },
    async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
      calls.push(name);
      if (name === "marlow" && request.userPrompt.includes("return ONLY a JSON")) return { text: JSON.stringify(script.plan), toolCalls: 0 };
      if (name === "marlow" && request.tools.some((tool) => tool.name === "assign_task")) {
        prompts.push(request.userPrompt);
        const act: Act = async (tool, args) => { const result = await request.execute(tool, args); results.push({ name: tool, result }); return result; };
        await (script.marlow ?? standard)(view(request.userPrompt), act);
        return { text: "Decided.", toolCalls: 1 };
      }
      const custom = await script.work?.(name, request);
      if (custom) return custom;
      if (/Begin with PASS: or ISSUES:/.test(request.userPrompt)) return { text: script.qa ?? "PASS: matches the task.", toolCalls: 0 };
      if (/Begin with APPROVED: or CHANGES_NEEDED:/.test(request.userPrompt)) return { text: script.review ?? "APPROVED: focused change.", toolCalls: 0 };
      return { text: "research notes", toolCalls: 0 };
    },
  });
  const providers = { marlow: fake("marlow"), juniper: fake("juniper"), kit: fake("kit"), wren: fake("wren"), rowan: fake("rowan"), tove: fake("tove"), piper: fake("piper"), hollis: fake("hollis") };
  return Object.assign(providers, { prompts, results, calls });
}

const writes = (request: ToolRequest) => request.tools.some((tool) => tool.name === "apply_patch");
const patch = (request: ToolRequest, oldText: string, newText: string) => request.execute("apply_patch", { path: "note.txt", oldText, newText });
const note = async (state: TeamRunState) => (await readFile(path.join(state.staging!.path, "note.txt"), "utf8")).replaceAll("\r\n", "\n");
const events = async (state: TeamRunState) => (await readFile(path.join(state.runDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { persona: string; event: string; detail: string });

test("Marlow directs dependent tasks through review, QA and integration, then the run waits for merge", async () => {
  const root = await repo();
  const providers = team({
    plan: { summary: "Improve note in three stages", tasks: [
      { id: "build", title: "Build wording", worker: "kit", dependsOn: [], research: true },
      { id: "interface", title: "Polish wording", worker: "wren", dependsOn: ["build"] },
      { id: "refactor", title: "Refactor wording", worker: "rowan", dependsOn: ["interface"] },
    ] },
    async work(name, request) {
      if (!["kit", "wren", "rowan"].includes(name) || !writes(request)) return undefined;
      const values: Record<string, [string, string]> = { kit: ["hello", "first"], wren: ["first", "second"], rowan: ["second", "final"] };
      await patch(request, ...values[name]);
      return { text: "Implemented task.", toolCalls: 1 };
    },
    async generate(name, request) {
      if (name !== "tove") return undefined;
      assert.match(request.userPrompt, /final world/);
      assert.match(request.userPrompt, /QA: PASS:/);
      return { text: "Verified note wording after checks." };
    },
  });
  const state = await runTeamGoal(root, "Improve the note", providers);
  assert.equal(state.status, "awaiting-review");
  assert.deepEqual(state.tasks.map((task) => task.status), ["done", "done", "done"]);
  assert.equal(new Set(state.tasks.map((task) => task.worktree?.path)).size, 3);
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "hello world\n");
  assert.equal(await note(state), "final world\n");
  assert.match((await reviewTeamRun(state.runDir)).diff, /final world/);
  assert.doesNotMatch(state.summary ?? "", /double-check|Shipping notes/, "no overrides and not an iOS release");
  assert.match(providers.prompts[0], /Hollis \(hollis\): iOS release engineer/, "Marlow sees the capability list");
  assert.ok(providers.calls.includes("juniper"), "research ran because Marlow asked for it");
  const log = await events(state);
  assert.ok(log.some((item) => item.event === "decision" && /^Marlow integrated "Refactor wording"/.test(item.detail)));
  assert.ok(log.some((item) => item.event === "decision" && /^Marlow asked Marlow to review|^Marlow asked Rowan to review/.test(item.detail)));
  const reply = await messageTeamPersona(state.runDir, "juniper", "What changed?", {
    name: "juniper",
    async generate(): Promise<ModelResponse> { return { text: "unused" }; },
    async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
      assert.equal(request.tools.some((tool) => tool.name === "apply_patch"), false);
      assert.equal(request.tools.some((tool) => tool.name === "run_checks"), false);
      return { text: "The note changed.", toolCalls: 0 };
    },
  });
  assert.equal(reply, "The note changed.");
  await assert.rejects(() => readFile(state.libraryPath, "utf8"), /ENOENT/);
  const merged = await mergeTeamRun(state.runDir);
  assert.equal(merged.status, "merged");
  assert.equal((await readFile(path.join(root, "note.txt"), "utf8")).replaceAll("\r\n", "\n"), "final world\n");
  assert.match(await readFile(state.libraryPath, "utf8"), /Verified note wording/);
  assert.equal(await git(root, ["status", "--porcelain"]), "");
});

test("independent tasks run in parallel and merge into staging", async () => {
  const root = await repo();
  await writeFile(path.join(root, "note.txt"), "alpha\nbeta\ngamma\ndelta\nepsilon\n");
  await git(root, ["commit", "-qam", "multi-line note"]);
  const working = new Set<string>();
  let overlapped = false;
  let release: () => void = () => undefined;
  const bothWorking = new Promise<void>((resolve) => { release = resolve; });
  const providers = team({
    plan: { summary: "Edit both ends", tasks: [
      { id: "start", title: "Change first line", worker: "kit", dependsOn: [] },
      { id: "end", title: "Change last line", worker: "wren", dependsOn: [] },
      { id: "polish", title: "Change middle line", worker: "rowan", dependsOn: ["start", "end"] },
    ] },
    async work(name, request) {
      if (!["kit", "wren", "rowan"].includes(name) || !writes(request)) return undefined;
      if (name !== "rowan") {
        working.add(name);
        if (working.size === 2) { overlapped = true; release(); }
        await Promise.race([bothWorking, new Promise((resolve) => setTimeout(resolve, 3_000))]);
      }
      const edits = { kit: ["alpha", "ALPHA"], wren: ["epsilon", "EPSILON"], rowan: ["gamma", "GAMMA"] } as Record<string, [string, string]>;
      await patch(request, ...edits[name]);
      return { text: "Implemented task.", toolCalls: 1 };
    },
  });
  const state = await runTeamGoal(root, "Edit the note", providers);
  assert.equal(state.status, "awaiting-review");
  assert.equal(overlapped, true, "kit and wren should work at the same time");
  assert.deepEqual(state.tasks.map((task) => task.status), ["done", "done", "done"]);
  assert.equal(await note(state), "ALPHA\nbeta\nGAMMA\ndelta\nEPSILON\n");
});

test("Marlow sends rejected work back with guidance, and the worker sees the review", async () => {
  const root = await repo();
  let edits = 0;
  let reviews = 0;
  const providers = team({
    plan: { summary: "Edit note", tasks: [{ id: "edit", title: "Edit note", worker: "kit", dependsOn: [] }] },
    async work(name, request) {
      if (name === "rowan" && /APPROVED: or CHANGES_NEEDED/.test(request.userPrompt)) return { text: ++reviews === 1 ? "CHANGES_NEEDED: say bright, not first" : "APPROVED: good", toolCalls: 0 };
      if (name !== "kit") return undefined;
      edits++;
      if (edits === 2) {
        assert.match(request.userPrompt, /Guidance from Marlow, the lead: Use bright/);
        assert.match(request.userPrompt, /CHANGES_NEEDED: say bright/);
      }
      await patch(request, edits === 1 ? "hello" : "first", edits === 1 ? "first" : "bright");
      return { text: "edited", toolCalls: 1 };
    },
    async marlow(seen, act) {
      for (const item of seen.events) {
        if (item.kind === "work-done") await act("request_review", { taskId: "edit", reviewer: "rowan" });
        if (item.kind === "review-done") {
          if (/review \(Rowan\): CHANGES_NEEDED/.test(seen.tasks[0].line)) {
            assert.match(seen.tasks[0].line, /failures so far: Kit 1/);
            await act("send_back", { taskId: "edit", guidance: "Use bright." });
          } else await act("integrate", { taskId: "edit", reason: "Rowan approved; QA adds nothing for a one-word change" });
        }
      }
      if (seen.idle && seen.tasks.every((task) => task.status === "done")) await act("finish", { summary: "Edited.", skipped: [{ step: "QA", reason: "one-word change" }] });
    },
  });
  const state = await runTeamGoal(root, "Edit note", providers);
  assert.equal(state.status, "awaiting-review");
  assert.equal(edits, 2);
  assert.equal(await note(state), "bright world\n");
  assert.equal(state.tasks[0].triageLog?.[0].guidance, "Use bright.");
  assert.match(state.summary ?? "", /Marlow's calls to double-check[\s\S]*"Edit note" was integrated with no QA\. Marlow: Rowan approved[\s\S]*Skipped QA: one-word change/);
});

test("Marlow may skip review and QA and integrate over failing checks; the summary lists it for the human", async () => {
  const root = await repo();
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "node -e \"process.exit(1)\"" } }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ name: "x", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "x", version: "1.0.0" } } }));
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "failing tests"]);
  const providers = team({
    plan: { summary: "Edit note", tasks: [{ id: "edit", title: "Edit note", worker: "kit", dependsOn: [] }] },
    async work(name, request) {
      if (name !== "kit") return undefined;
      await patch(request, "hello", "bright");
      return { text: "edited", toolCalls: 1 };
    },
    async marlow(seen, act) {
      if (seen.events.some((item) => item.kind === "work-done")) {
        assert.match(seen.tasks[0].line, /checks: .*(failed|missing)/);
        await act("integrate", { taskId: "edit", reason: "the test failure predates this change" });
      }
      if (seen.events.some((item) => item.kind === "integrate-done")) await act("finish", { summary: "Edited." });
    },
  });
  const state = await runTeamGoal(root, "Edit note", providers);
  assert.equal(state.status, "awaiting-review");
  assert.equal(await note(state), "bright world\n");
  assert.equal(providers.calls.filter((name) => name === "rowan" || name === "tove").length, 0, "no review or QA was run");
  assert.match(state.director!.overrides[0], /checks failing or missing \(.*\), no review, no QA\. Marlow: the test failure predates this change/);
  assert.match(state.summary ?? "", /Marlow's calls to double-check/);
});

test("replaying the Rowan archive loop: after repeated failures Marlow sees the counts and reassigns to Hollis", async () => {
  const root = await repo();
  let rowanTries = 0;
  let hollisSawHandover = false;
  const providers = team({
    plan: { summary: "Release", tasks: [{ id: "archive", title: "Archive the app for the App Store", worker: "rowan", dependsOn: [] }] },
    async work(name, request) {
      if (name === "rowan" && writes(request)) { rowanTries++; return { text: "NEEDS_INPUT: I have no archive tool; only run_checks.", toolCalls: 0 }; }
      if (name === "hollis") {
        hollisSawHandover = /taking this task over from Rowan because Rowan has no archive tool/.test(request.userPrompt);
        assert.ok(!request.tools.some((tool) => tool.name === "apply_patch"), "Hollis is verify-only inside a run");
        return { text: "Verified: archive must be done by Jake via chat after merge; readiness checked.", toolCalls: 0 };
      }
      return undefined;
    },
    async marlow(seen, act) {
      for (const item of seen.events) {
        if (item.kind === "work-failed") {
          const count = Number(/failures so far: Rowan (\d+)/.exec(seen.tasks[0].line)?.[1] ?? 0);
          if (count < 3) await act("send_back", { taskId: "archive", guidance: "Try the archive again." });
          else await act("reassign", { taskId: "archive", persona: "hollis", reason: "Rowan has no archive tool" });
        }
        if (item.kind === "work-done") await act("integrate", { taskId: "archive", reason: "verification only" });
        if (item.kind === "integrate-done") await act("finish", { summary: "Verified." });
      }
    },
  });
  const state = await runTeamGoal(root, "Archive the app", providers);
  assert.equal(state.status, "awaiting-review");
  assert.equal(rowanTries, 3);
  assert.equal(hollisSawHandover, true);
  assert.equal(state.plan!.tasks[0].worker, "hollis");
  assert.equal(state.tasks[0].failures?.rowan, 3);
  assert.ok(providers.prompts.some((prompt) => /failures so far: Rowan 3/.test(prompt)));
  assert.ok((await events(state)).some((item) => item.event === "decision" && item.detail === `Marlow moved "Archive the app for the App Store" from Rowan to Hollis because Rowan has no archive tool`));
});

test("invalid actions come back to Marlow as errors, and the decision backstop hands the run to the human", async () => {
  const root = await repo();
  const previous = process.env.AGENT_TEAM_MAX_DECISIONS;
  process.env.AGENT_TEAM_MAX_DECISIONS = "6";
  try {
    const providers = team({
      plan: { summary: "Edit note", tasks: [{ id: "edit", title: "Edit note", worker: "kit", dependsOn: [] }] },
      async work(name, request) {
        if (name !== "kit") return undefined;
        await patch(request, "hello", "bright");
        return { text: "edited", toolCalls: 1 };
      },
      async marlow(_seen, act) {
        await act("assign_task", { persona: "nobody", title: "x" });
        await act("integrate", { taskId: "missing" });
        await act("reassign", { taskId: "edit", persona: "marlow", reason: "x" });
        await act("request_review", { taskId: "edit", reviewer: "kit" });
        await act("send_back", { taskId: "edit" });
        await act("integrate", { taskId: "missing" });
      },
    });
    const state = await runTeamGoal(root, "Edit note", providers);
    const errors = providers.results.map((item) => item.result);
    assert.ok(errors.every((result) => result.isError));
    assert.match(errors[0].content, /Unknown persona "nobody"/);
    assert.match(errors[1].content, /There is no task "missing"\. Tasks: edit/);
    assert.match(errors[2].content, /Unknown persona "marlow"/);
    assert.match(errors[3].content, /Kit did this task/);
    assert.match(errors[4].content, /send_back needs "guidance"/);
    assert.match(errors[5].content, /Decision limit reached \(6\)/);
    assert.equal(state.status, "blocked");
    assert.match(state.question?.summary ?? "", /most allowed before checking in with you/);
    assert.equal(state.director!.history.filter((item) => !item.ok).length, 5);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAM_MAX_DECISIONS; else process.env.AGENT_TEAM_MAX_DECISIONS = previous;
  }
});

function askThenAnswer(): ReturnType<typeof team> & { workerCalls: () => number } {
  let workerCalls = 0;
  const providers = team({
    plan: { summary: "Edit note", tasks: [{ id: "edit", title: "Edit note", worker: "kit", dependsOn: [] }] },
    async work(name, request) {
      if (name !== "kit") return undefined;
      workerCalls++;
      if (workerCalls === 1) return { text: "NEEDS_INPUT: Which word should replace hello?", toolCalls: 0 };
      assert.match(request.userPrompt, /Guidance from Marlow, the lead: Jake says: bright/);
      await patch(request, "hello", "bright");
      return { text: "edited", toolCalls: 1 };
    },
    async marlow(seen, act) {
      for (const item of seen.events) {
        if (item.kind === "work-failed") await act("ask_human", { summary: "Kit needs to know which word to use. Nothing in the project says.", options: ["Use bright", "Keep hello"], recommended: "Use bright.", taskId: "edit" });
        if (item.kind === "human-answer") await act("send_back", { taskId: "edit", guidance: `Jake says: ${/Jake answered[^:]*\): (.*)/.exec(seen.prompt)?.[1]}` });
        if (item.kind === "work-done") await act("integrate", { taskId: "edit", reason: "Jake chose the word" });
        if (item.kind === "integrate-done") await act("finish", { summary: "Edited." });
      }
    },
  });
  return Object.assign(providers, { workerCalls: () => workerCalls });
}

test("Marlow asks the human, and the answer resumes the run in the same worktree", async () => {
  const root = await repo();
  const providers = askThenAnswer();
  const blocked = await runTeamGoal(root, "Edit note", providers);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.question?.summary, "Kit needs to know which word to use. Nothing in the project says.");
  assert.deepEqual(blocked.question?.options, ["Use bright", "Keep hello"]);
  assert.equal(blocked.tasks[0].triageNote?.recommended, "Use bright.");
  assert.match(blocked.tasks[0].error ?? "", /NEEDS_INPUT/);
  await assert.rejects(() => mergeTeamRun(blocked.runDir), /not ready/);
  const worktree = blocked.tasks[0].worktree?.path;
  const resumed = await answerTeamRun(blocked.runDir, "bright", providers);
  assert.equal(resumed.status, "awaiting-review");
  assert.equal(resumed.question, undefined);
  assert.equal(resumed.tasks[0].worktree?.path, worktree);
  assert.equal(providers.workerCalls(), 2);
  assert.equal(resumed.decisions?.[0].answer, "bright");
  assert.equal(await note(resumed), "bright world\n");
  assert.ok(resumed.director!.history.some((item) => item.action === "ask_human") && resumed.director!.history.some((item) => item.action === "send_back"));
});

test("answering a blocked run after the checkout moved on brings the run up to date and continues", async () => {
  const root = await repo();
  const providers = askThenAnswer();
  const blocked = await runTeamGoal(root, "Edit note", providers);
  assert.equal(blocked.status, "blocked");
  await writeFile(path.join(root, "other.txt"), "merged elsewhere\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "parallel run merged"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const resumed = await answerTeamRun(blocked.runDir, "bright", providers);
  assert.equal(resumed.status, "awaiting-review");
  assert.equal(resumed.baseCommit, head);
  assert.equal((await readFile(path.join(resumed.staging!.path, "other.txt"), "utf8")).replaceAll("\r\n", "\n"), "merged elsewhere\n");
  assert.equal(await note(resumed), "bright world\n");
  const review = await reviewTeamRun(resumed.runDir);
  assert.match(review.diff, /bright world/);
  assert.doesNotMatch(review.diff, /merged elsewhere/);
  assert.equal((await mergeTeamRun(resumed.runDir)).status, "merged");
});

test("a plan reply that fails twice reports Marlow's raw reply and saves both replies", async () => {
  const root = await repo();
  let retryTokens: number | undefined;
  const cutOff = `{"summary":"I read the repository. Kit covers the audit and Hollis's release work is split","tasks":[{"id":"audit","title":"Check force unwraps`;
  const fake = (name: string): TeamProviders["marlow"] => ({
    name,
    async generate(request: ModelRequest): Promise<ModelResponse> {
      if (name === "marlow") retryTokens = request.maxOutputTokens;
      return { text: cutOff };
    },
    async generateWithTools(): Promise<ToolResponse> { return { text: `Here is the plan:\n\`\`\`json\n${cutOff}`, toolCalls: 0 }; },
  } as ModelProvider & { generateWithTools(): Promise<ToolResponse> });
  const providers: TeamProviders = { marlow: fake("marlow"), juniper: fake("juniper"), kit: fake("kit"), wren: fake("wren"), rowan: fake("rowan"), tove: fake("tove"), piper: fake("piper") };
  const error = await runTeamGoal(root, "Get the app ready for release", providers).then(() => undefined, (caught: Error) => caught);
  assert.ok(error);
  assert.match(error.message, /valid JSON plan.*cut off/);
  assert.match(error.message, /Marlow's reply:\n\{"summary":"I read the repository/);
  const saved = error.message.match(/Full replies saved at: (.+)/)![1].split("\n")[0].trim();
  assert.match(await readFile(saved, "utf8"), /First reply:\nHere is the plan:[\s\S]*Retry reply:/);
  assert.ok((retryTokens ?? 0) >= 8192, "the retry has room for a long plan");
});

test("discarding a run removes its worktrees, branches and saved state but keeps merged code", async () => {
  const root = await repo();
  const blocked = await runTeamGoal(root, "Edit note", askThenAnswer());
  const dirs = [blocked.staging!.path, blocked.tasks[0].worktree!.path];
  const result = await deleteTeamRun(blocked.runDir);
  assert.equal(result.id, blocked.id);
  assert.ok(result.removedWorktrees >= 2);
  assert.ok(result.removedBranches.length >= 2);
  assert.ok(!(await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/codex/"])).includes(blocked.id));
  for (const dir of dirs) await assert.rejects(() => readFile(path.join(dir, "note.txt"), "utf8"), /ENOENT/);
  await assert.rejects(() => readFile(path.join(blocked.runDir, "state.json"), "utf8"), /ENOENT/);
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "hello world\n");
});
