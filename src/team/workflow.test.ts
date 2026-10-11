import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tempRepo } from "../coding/test-helpers.js";
import { git } from "../coding/git.js";
import type { ModelProvider, ModelRequest, ModelResponse, ToolRequest, ToolResponse } from "../core/provider.js";
import { repoHome } from "./state.js";
import { deleteTeamRun } from "./run-cleanup.js";
import { answerTeamRun, mergeTeamRun, messageTeamPersona, parseEscalation, reviewTeamRun, runTeamGoal, type TeamProviders } from "./workflow.js";

const cleanup: Array<{ parent: string; home: string }> = [];
after(async () => {
  for (const item of cleanup) {
    assert.equal(path.dirname(item.parent), os.tmpdir());
    assert.equal(path.dirname(item.home), path.join(os.homedir(), ".agent-team", "repos"));
    await rm(item.parent, { recursive: true, force: true });
    await rm(item.home, { recursive: true, force: true });
  }
});

test("six personas move dependent tasks through separate worktrees and wait for merge", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push({ parent, home: repoHome(root) });
  const calls: string[] = [];
  const plan = { summary: "Improve note in three stages", tasks: [
    { id: "build", title: "Build wording", worker: "kit", dependsOn: [] },
    { id: "interface", title: "Polish wording", worker: "wren", dependsOn: ["build"] },
    { id: "refactor", title: "Refactor wording", worker: "rowan", dependsOn: ["interface"] },
  ] };
  function fake(name: string): ModelProvider & { generateWithTools(request: ToolRequest): Promise<ToolResponse> } {
    return {
      name,
      async generate(request: ModelRequest): Promise<ModelResponse> {
        if (name === "tove") {
          assert.match(request.userPrompt, /final world/);
          assert.match(request.userPrompt, /QA: PASS:/);
          return { text: "Verified note wording after checks." };
        }
        return { text: "Ready for human review." };
      },
      async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
        calls.push(name);
        if (name === "marlow" && request.userPrompt.includes("return ONLY a JSON")) return { text: JSON.stringify(plan), toolCalls: 0 };
        if (name === "kit" || name === "wren" || name === "rowan" && request.tools.some((tool) => tool.name === "apply_patch")) {
          const values: Record<string, [string, string]> = { kit: ["hello", "first"], wren: ["first", "second"], rowan: ["second", "final"] };
          const [oldText, newText] = values[name];
          await request.execute("apply_patch", { path: "note.txt", oldText, newText });
          return { text: "Implemented task.", toolCalls: 1 };
        }
        if (name === "tove") return { text: "PASS: note matches the task; no automatic checks were detected.", toolCalls: 0 };
        return { text: "APPROVED: focused change.", toolCalls: 0 };
      },
    };
  }
  const providers: TeamProviders = {
    marlow: fake("marlow"), juniper: fake("juniper"), kit: fake("kit"),
    wren: fake("wren"), rowan: fake("rowan"), tove: fake("tove"), piper: fake("piper"),
  };
  const state = await runTeamGoal(root, "Improve the note", providers);
  assert.equal(state.status, "awaiting-review");
  assert.deepEqual(state.tasks.map((task) => task.status), ["done", "done", "done"]);
  assert.equal(new Set(state.tasks.map((task) => task.worktree?.path)).size, 3);
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "hello world\n");
  assert.equal((await readFile(path.join(state.staging!.path, "note.txt"), "utf8")).replaceAll("\r\n", "\n"), "final world\n");
  assert.match((await reviewTeamRun(state.runDir)).diff, /final world/);
  const reply = await messageTeamPersona(state.runDir, "juniper", "What changed?", {
    name: "juniper",
    async generate(): Promise<ModelResponse> { return { text: "unused" }; },
    async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
      assert.equal(request.tools.some((tool) => tool.name === "apply_patch"), false);
      assert.equal(request.tools.some((tool) => tool.name === "inspect_build_environment"), true);
      assert.equal(request.tools.some((tool) => tool.name === "run_checks"), false);
      assert.equal(request.tools.some((tool) => tool.name === "create_png"), false);
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
  for (const persona of ["marlow", "juniper", "kit", "wren", "rowan", "tove"]) assert.ok(calls.includes(persona));
});

test("independent tasks run in parallel and merge into staging", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push({ parent, home: repoHome(root) });
  await writeFile(path.join(root, "note.txt"), "alpha\nbeta\ngamma\ndelta\nepsilon\n");
  await git(root, ["commit", "-qam", "multi-line note"]);
  const plan = { summary: "Edit both ends", tasks: [
    { id: "start", title: "Change first line", worker: "kit", dependsOn: [] },
    { id: "end", title: "Change last line", worker: "wren", dependsOn: [] },
    { id: "polish", title: "Change middle line", worker: "rowan", dependsOn: ["start", "end"] },
  ] };
  const working = new Set<string>();
  let overlapped = false;
  let release: () => void = () => undefined;
  const bothWorking = new Promise<void>((resolve) => { release = resolve; });
  function fake(name: string): ModelProvider & { generateWithTools(request: ToolRequest): Promise<ToolResponse> } {
    return {
      name,
      async generate(): Promise<ModelResponse> { return { text: "Ready for human review." }; },
      async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
        if (name === "marlow" && request.userPrompt.includes("return ONLY a JSON")) return { text: JSON.stringify(plan), toolCalls: 0 };
        if (request.tools.some((tool) => tool.name === "apply_patch") && (name === "kit" || name === "wren" || name === "rowan")) {
          if (name !== "rowan") {
            working.add(name);
            if (working.size === 2) { overlapped = true; release(); }
            await Promise.race([bothWorking, new Promise((resolve) => setTimeout(resolve, 3_000))]);
          }
          const edits = { kit: ["alpha", "ALPHA"], wren: ["epsilon", "EPSILON"], rowan: ["gamma", "GAMMA"] } as const;
          await request.execute("apply_patch", { path: "note.txt", oldText: edits[name][0], newText: edits[name][1] });
          return { text: "Implemented task.", toolCalls: 1 };
        }
        if (name === "tove") return { text: "PASS: matches the task.", toolCalls: 0 };
        return { text: "APPROVED: focused change.", toolCalls: 0 };
      },
    };
  }
  const providers: TeamProviders = {
    marlow: fake("marlow"), juniper: fake("juniper"), kit: fake("kit"),
    wren: fake("wren"), rowan: fake("rowan"), tove: fake("tove"), piper: fake("piper"),
  };
  const state = await runTeamGoal(root, "Edit the note", providers);
  assert.equal(state.status, "awaiting-review");
  assert.equal(overlapped, true, "kit and wren should work at the same time");
  assert.deepEqual(state.tasks.map((task) => task.status), ["done", "done", "done"]);
  const merged = (await readFile(path.join(state.staging!.path, "note.txt"), "utf8")).replaceAll("\r\n", "\n");
  assert.equal(merged, "ALPHA\nbeta\nGAMMA\ndelta\nEPSILON\n");
});

test("unresolved review blocks integration and merge after one repair pass", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push({ parent, home: repoHome(root) });
  let edits = 0;
  function fake(name: string): ModelProvider & { generateWithTools(request: ToolRequest): Promise<ToolResponse> } {
    return {
      name,
      async generate(): Promise<ModelResponse> { return { text: "summary" }; },
      async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
        if (name === "marlow") return { text: JSON.stringify({ summary: "Edit note", tasks: [{ id: "edit", title: "Edit note", worker: "kit", dependsOn: [] }] }), toolCalls: 0 };
        if (name === "kit") {
          edits++;
          await request.execute("apply_patch", { path: "note.txt", oldText: edits === 1 ? "hello" : "first", newText: edits === 1 ? "first" : "second" });
          return { text: "edited", toolCalls: 1 };
        }
        if (name === "rowan") return { text: "CHANGES_NEEDED: unresolved issue", toolCalls: 0 };
        if (name === "tove") return { text: "PASS: checked", toolCalls: 0 };
        return { text: "research", toolCalls: 0 };
      },
    };
  }
  const providers: TeamProviders = {
    marlow: fake("marlow"), juniper: fake("juniper"), kit: fake("kit"),
    wren: fake("wren"), rowan: fake("rowan"), tove: fake("tove"), piper: fake("piper"),
  };
  const state = await runTeamGoal(root, "Edit note", providers);
  assert.equal(edits, 2);
  assert.equal(state.status, "blocked");
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "hello world\n");
  assert.equal((await readFile(path.join(state.staging!.path, "note.txt"), "utf8")).replaceAll("\r\n", "\n"), "hello world\n");
  await assert.rejects(() => mergeTeamRun(state.runDir), /not ready/);
});

test("a human answer resumes a blocked worker in the same worktree", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push({ parent, home: repoHome(root) });
  let workerCalls = 0;
  function fake(name: string): ModelProvider & { generateWithTools(request: ToolRequest): Promise<ToolResponse> } {
    return {
      name,
      async generate(): Promise<ModelResponse> { return { text: "summary" }; },
      async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
        if (name === "marlow") return { text: JSON.stringify({ summary: "Edit note", tasks: [{ id: "edit", title: "Edit note", worker: "kit", dependsOn: [] }] }), toolCalls: 0 };
        if (name === "kit") {
          workerCalls++;
          if (workerCalls === 1) return { text: "NEEDS_INPUT: Which word should replace hello?", toolCalls: 0 };
          assert.match(request.userPrompt, /Human answer or guidance: Use bright/);
          await request.execute("apply_patch", { path: "note.txt", oldText: "hello", newText: "bright" });
          return { text: "edited", toolCalls: 1 };
        }
        if (name === "rowan") return { text: "APPROVED: correct", toolCalls: 0 };
        if (name === "tove") return { text: "PASS: correct", toolCalls: 0 };
        return { text: "research", toolCalls: 0 };
      },
    };
  }
  const providers: TeamProviders = {
    marlow: fake("marlow"), juniper: fake("juniper"), kit: fake("kit"),
    wren: fake("wren"), rowan: fake("rowan"), tove: fake("tove"), piper: fake("piper"),
  };
  const blocked = await runTeamGoal(root, "Edit note", providers);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.tasks[0].error ?? "", /NEEDS_INPUT/);
  assert.doesNotMatch(blocked.tasks[0].error ?? "", /Marlow/);
  assert.ok(blocked.tasks[0].triageNote?.summary);
  const worktree = blocked.tasks[0].worktree?.path;
  const resumed = await answerTeamRun(blocked.runDir, "Use bright", providers);
  assert.equal(resumed.status, "awaiting-review");
  assert.equal(resumed.tasks[0].worktree?.path, worktree);
  assert.equal(workerCalls, 2);
  assert.equal(resumed.decisions?.[0].answer, "Use bright");
  assert.equal((await readFile(path.join(resumed.staging!.path, "note.txt"), "utf8")).replaceAll("\r\n", "\n"), "bright world\n");
});

test("Marlow answers a worker's question before the human is asked", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push({ parent, home: repoHome(root) });
  let workerCalls = 0;
  function fake(name: string): ModelProvider & { generateWithTools(request: ToolRequest): Promise<ToolResponse> } {
    return {
      name,
      async generate(): Promise<ModelResponse> { return { text: "summary" }; },
      async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
        if (name === "marlow") {
          if (request.userPrompt.includes("A teammate is blocked")) return { text: "GUIDANCE: Use bright.", toolCalls: 0 };
          return { text: JSON.stringify({ summary: "Edit note", tasks: [{ id: "edit", title: "Edit note", worker: "kit", dependsOn: [] }] }), toolCalls: 0 };
        }
        if (name === "kit") {
          workerCalls++;
          if (workerCalls === 1) return { text: "NEEDS_INPUT: Which word should replace hello?", toolCalls: 0 };
          assert.match(request.userPrompt, /from Marlow, the lead\) Use bright/);
          await request.execute("apply_patch", { path: "note.txt", oldText: "hello", newText: "bright" });
          return { text: "edited", toolCalls: 1 };
        }
        if (name === "rowan") return { text: "APPROVED: correct", toolCalls: 0 };
        if (name === "tove") return { text: "PASS: correct", toolCalls: 0 };
        return { text: "research", toolCalls: 0 };
      },
    };
  }
  const providers: TeamProviders = {
    marlow: fake("marlow"), juniper: fake("juniper"), kit: fake("kit"),
    wren: fake("wren"), rowan: fake("rowan"), tove: fake("tove"), piper: fake("piper"),
  };
  const state = await runTeamGoal(root, "Edit note", providers);
  assert.equal(state.status, "awaiting-review");
  assert.equal(workerCalls, 2);
  assert.match(state.decisions?.[0].answer ?? "", /^Marlow: Use bright/);
  assert.equal(state.tasks[0].triageLog?.[0].guidance, "Use bright.");
});

test("Marlow's escalation is parsed into a plain-English summary, options and a recommendation", () => {
  const note = parseEscalation("ESCALATE:\nSUMMARY: Kit needs to know which word to use. Nothing in the project says.\nOPTIONS:\n- Use the word bright\n2. Keep the original word\nRECOMMENDED: Use bright, since it matches the rest of the page.");
  assert.equal(note.summary, "Kit needs to know which word to use. Nothing in the project says.");
  assert.deepEqual(note.options, ["Use the word bright", "Keep the original word"]);
  assert.match(note.recommended ?? "", /^Use bright/);
  assert.deepEqual(parseEscalation("ESCALATE: Just a sentence.").options, []);
});

function blockedThenAnswerProviders(): TeamProviders {
  let workerCalls = 0;
  function fake(name: string): ModelProvider & { generateWithTools(request: ToolRequest): Promise<ToolResponse> } {
    return {
      name,
      async generate(): Promise<ModelResponse> { return { text: "summary" }; },
      async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
        if (name === "marlow") {
          if (request.userPrompt.includes("A teammate is blocked")) return { text: "ESCALATE:\nSUMMARY: Need a word.\nOPTIONS:\n- bright\nRECOMMENDED: bright", toolCalls: 0 };
          return { text: JSON.stringify({ summary: "Edit note", tasks: [{ id: "edit", title: "Edit note", worker: "kit", dependsOn: [] }] }), toolCalls: 0 };
        }
        if (name === "kit") {
          workerCalls++;
          if (workerCalls === 1) return { text: "NEEDS_INPUT: Which word should replace hello?", toolCalls: 0 };
          await request.execute("apply_patch", { path: "note.txt", oldText: "hello", newText: "bright" });
          return { text: "edited", toolCalls: 1 };
        }
        if (name === "rowan") return { text: "APPROVED: correct", toolCalls: 0 };
        if (name === "tove") return { text: "PASS: correct", toolCalls: 0 };
        return { text: "research", toolCalls: 0 };
      },
    };
  }
  return { marlow: fake("marlow"), juniper: fake("juniper"), kit: fake("kit"), wren: fake("wren"), rowan: fake("rowan"), tove: fake("tove"), piper: fake("piper") };
}

test("answering a blocked run after the checkout moved on brings the run up to date and continues", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push({ parent, home: repoHome(root) });
  const providers = blockedThenAnswerProviders();
  const blocked = await runTeamGoal(root, "Edit note", providers);
  assert.equal(blocked.status, "blocked");
  await writeFile(path.join(root, "other.txt"), "merged elsewhere\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "parallel run merged"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const resumed = await answerTeamRun(blocked.runDir, "bright", providers);
  assert.equal(resumed.status, "awaiting-review");
  assert.equal(resumed.baseCommit, head);
  const staged = resumed.staging!.path;
  assert.equal((await readFile(path.join(staged, "other.txt"), "utf8")).replaceAll("\r\n", "\n"), "merged elsewhere\n");
  assert.equal((await readFile(path.join(staged, "note.txt"), "utf8")).replaceAll("\r\n", "\n"), "bright world\n");
  const review = await reviewTeamRun(resumed.runDir);
  assert.match(review.diff, /bright world/);
  assert.doesNotMatch(review.diff, /merged elsewhere/);
  const merged = await mergeTeamRun(resumed.runDir);
  assert.equal(merged.status, "merged");
});

test("discarding a run removes its worktrees, branches and saved state but keeps merged code", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push({ parent, home: repoHome(root) });
  const blocked = await runTeamGoal(root, "Edit note", blockedThenAnswerProviders());
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
