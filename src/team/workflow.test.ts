import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tempRepo } from "../coding/test-helpers.js";
import { git } from "../coding/git.js";
import type { ModelProvider, ModelRequest, ModelResponse, ToolRequest, ToolResponse } from "../core/provider.js";
import { repoHome } from "./state.js";
import { mergeTeamRun, reviewTeamRun, runTeamGoal, type TeamProviders } from "./workflow.js";

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
      async generate(_request: ModelRequest): Promise<ModelResponse> { return { text: name === "tove" ? "Verified note wording after checks." : "Ready for human review." }; },
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
    wren: fake("wren"), rowan: fake("rowan"), tove: fake("tove"),
  };
  const state = await runTeamGoal(root, "Improve the note", providers);
  assert.equal(state.status, "awaiting-review");
  assert.deepEqual(state.tasks.map((task) => task.status), ["done", "done", "done"]);
  assert.equal(new Set(state.tasks.map((task) => task.worktree?.path)).size, 3);
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "hello world\n");
  assert.equal((await readFile(path.join(state.staging!.path, "note.txt"), "utf8")).replaceAll("\r\n", "\n"), "final world\n");
  assert.match((await reviewTeamRun(state.runDir)).diff, /final world/);
  await assert.rejects(() => readFile(state.libraryPath, "utf8"), /ENOENT/);
  const merged = await mergeTeamRun(state.runDir);
  assert.equal(merged.status, "merged");
  assert.equal((await readFile(path.join(root, "note.txt"), "utf8")).replaceAll("\r\n", "\n"), "final world\n");
  assert.match(await readFile(state.libraryPath, "utf8"), /Verified note wording/);
  assert.equal(await git(root, ["status", "--porcelain"]), "");
  for (const persona of ["marlow", "juniper", "kit", "wren", "rowan", "tove"]) assert.ok(calls.includes(persona));
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
    wren: fake("wren"), rowan: fake("rowan"), tove: fake("tove"),
  };
  const state = await runTeamGoal(root, "Edit note", providers);
  assert.equal(edits, 2);
  assert.equal(state.status, "blocked");
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "hello world\n");
  assert.equal((await readFile(path.join(state.staging!.path, "note.txt"), "utf8")).replaceAll("\r\n", "\n"), "hello world\n");
  await assert.rejects(() => mergeTeamRun(state.runDir), /not ready/);
});
