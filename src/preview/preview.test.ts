import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { tempRepo } from "../coding/test-helpers.js";
import { createBranchWorktree, git } from "../coding/git.js";
import { createRunState } from "../team/state.js";
import { inspectPreview, pathUrl, runBrowserSteps } from "./browser.js";
import { commandRisk, parseCookbook, readCookbook, saveCookbook } from "./cookbook.js";
import { getSecret, listSecrets, setSecret } from "./secrets.js";
import { PreviewPause, startPreview, stopPreview } from "./runtime.js";
import { runTeamGoal, type TeamProviders } from "../team/workflow.js";
import type { ModelRequest, ToolRequest } from "../core/provider.js";

test("Piper cookbook validates paths and flags risky commands", async () => {
  const book = parseCookbook({ version: 1, workingDir: ".", setup: [], build: [], start: "npm run dev", healthPath: "/", variables: {}, secrets: {} });
  assert.equal(book.start, "npm run dev");
  assert.throws(() => parseCookbook({ ...book, workingDir: "../outside" }), /worktree/);
  assert.throws(() => parseCookbook({ ...book, healthPath: "/\\evil.example" }), /local URL/);
  assert.throws(() => pathUrl("http://127.0.0.1:4173/", "/\\evil.example"), /local path/);
  assert.equal(pathUrl("http://127.0.0.1:4173/", "/status"), "http://127.0.0.1:4173/status");
  assert.match(await commandRisk("git push origin main", process.cwd()) ?? "", /outside/);
});

test("a web goal reaches Piper's preview and Wren's browser review before merge", async () => {
  const { root, parent } = await tempRepo();
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-preview-team-"));
  const previous = process.env.AGENT_TEAM_DATA_DIR;
  process.env.AGENT_TEAM_DATA_DIR = data;
  const runIds: string[] = [];
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "node server.cjs" } }));
    await writeFile(path.join(root, "server.cjs"), `require('node:http').createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<h1>Hello web</h1>')}).listen(Number(process.env.PORT),'127.0.0.1')`);
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "web fixture"]);
    const calls: string[] = [];
    let reviewRound = 0;
    let approveSecond = true;
    let visualFixCalls = 0;
    const fake = (name: string) => ({
      name,
      async generate(request: ModelRequest) {
        calls.push(`${name}:generate`);
        if (name === "wren" && request.userPrompt.includes("Return a short JSON object")) {
          assert(request.images?.length);
          return { text: JSON.stringify({ scenarios: [{ action: "expectText", text: reviewRound === 0 ? "Hello preview" : "Hello polished" }] }) };
        }
        if (name === "wren") return { text: reviewRound++ === 0 || !approveSecond ? "ISSUES: The heading needs a polished label." : "PASS: The polished staged heading is visible and the browser scenario passed." };
        return { text: "Completed and verified." };
      },
      async generateWithTools(request: ToolRequest) {
        calls.push(`${name}:tools`);
        if (name === "marlow") return { text: JSON.stringify({ summary: "Change heading", tasks: [{ id: "heading", title: "Change web heading", worker: "kit", dependsOn: [] }] }), toolCalls: 0 };
        if (name === "piper") return { text: JSON.stringify({ version: 1, workingDir: ".", setup: [], build: [], start: "npm run dev", healthPath: "/", variables: {}, secrets: {} }), toolCalls: 0 };
        if (name === "kit") { await request.execute("apply_patch", { path: "server.cjs", oldText: "Hello web", newText: "Hello preview" }); return { text: "Updated heading.", toolCalls: 1 }; }
        if (name === "wren") { visualFixCalls++; await request.execute("apply_patch", { path: "server.cjs", oldText: "Hello preview", newText: "Hello polished" }); return { text: "Polished heading.", toolCalls: 1 }; }
        if (name === "rowan") return { text: "APPROVED: focused heading edit.", toolCalls: 0 };
        if (name === "tove") return { text: "PASS: heading meets the task.", toolCalls: 0 };
        return { text: "Found the web server file.", toolCalls: 0 };
      },
    });
    const providers = Object.fromEntries(["marlow", "juniper", "kit", "wren", "rowan", "tove", "piper"].map((name) => [name, fake(name)])) as unknown as TeamProviders;
    const state = await runTeamGoal(root, "Change the web heading", providers);
    runIds.push(state.id);
    assert.equal(state.status, "awaiting-review");
    assert.equal(state.preview?.status, "healthy");
    assert.equal(state.preview?.visualVerified, true);
    assert.equal(state.preview?.visualFixAttempted, true);
    assert(state.preview?.browserResults?.some((item) => item.step.includes("expectText") && item.status === "passed"));
    assert(calls.includes("piper:tools"));
    assert(calls.includes("wren:generate"));
    assert.equal(await readFile(path.join(root, "server.cjs"), "utf8").then((text) => text.includes("Hello web")), true);
    await stopPreview(state.id);
    reviewRound = 0; approveSecond = false;
    const unresolved = await runTeamGoal(root, "Change the web heading again", providers);
    runIds.push(unresolved.id);
    assert.equal(unresolved.status, "blocked");
    assert.equal(unresolved.preview?.visualFixAttempted, true);
    assert.equal(visualFixCalls, 2, "one visual fix per run");
  } finally {
    for (const id of runIds) await stopPreview(id);
    if (previous === undefined) delete process.env.AGENT_TEAM_DATA_DIR; else process.env.AGENT_TEAM_DATA_DIR = previous;
    await rm(parent, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test("Piper stops after four cookbook repairs and reports a code diagnosis", async () => {
  const { root, parent } = await tempRepo();
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-preview-retry-"));
  const previous = process.env.AGENT_TEAM_DATA_DIR;
  process.env.AGENT_TEAM_DATA_DIR = data;
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "node missing.cjs" } }));
    await git(root, ["add", "-A"]); await git(root, ["commit", "-m", "broken web fixture"]);
    let cookbookCalls = 0, diagnosisCalls = 0;
    const fake = (name: string) => ({
      name,
      async generate() { return { text: "summary" }; },
      async generateWithTools(request: ToolRequest) {
        if (name === "marlow") return { text: JSON.stringify({ summary: "Edit note", tasks: [{ id: "note", title: "Edit note", worker: "kit", dependsOn: [] }] }), toolCalls: 0 };
        if (name === "kit") { await request.execute("apply_patch", { path: "note.txt", oldText: "hello", newText: "bright" }); return { text: "edited", toolCalls: 1 }; }
        if (name === "rowan") return { text: "APPROVED: focused", toolCalls: 0 };
        if (name === "tove") return { text: "PASS: focused", toolCalls: 0 };
        if (name === "piper") {
          if (request.userPrompt.includes("Explain the likely application code change")) { diagnosisCalls++; return { text: "Create or correct the missing server.cjs entrypoint.", toolCalls: 0 }; }
          cookbookCalls++;
          return { text: JSON.stringify({ version: 1, workingDir: ".", setup: [], build: [], start: "node missing.cjs", healthPath: "/", variables: {}, secrets: {} }), toolCalls: 0 };
        }
        return { text: "research", toolCalls: 0 };
      },
    });
    const providers = Object.fromEntries(["marlow", "juniper", "kit", "wren", "rowan", "tove", "piper"].map((name) => [name, fake(name)])) as unknown as TeamProviders;
    const state = await runTeamGoal(root, "Edit note in web app", providers);
    assert.equal(state.status, "blocked");
    assert.equal(state.preview?.piperAttempts, 5);
    assert.equal(cookbookCalls, 5);
    assert.equal(diagnosisCalls, 1);
    assert.match(state.preview?.issue ?? "", /server\.cjs/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAM_DATA_DIR; else process.env.AGENT_TEAM_DATA_DIR = previous;
    await rm(parent, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test("preview uses a cookbook, redacts secrets, captures browser evidence, and stops", async () => {
  const { root, parent } = await tempRepo();
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-preview-data-"));
  const previous = process.env.AGENT_TEAM_DATA_DIR;
  process.env.AGENT_TEAM_DATA_DIR = data;
  let runId: string | undefined;
  try {
    const state = await createRunState(root, "Add a preview button", await git(root, ["rev-parse", "HEAD"]));
    runId = state.id;
    state.staging = await createBranchWorktree(root, `codex/team-${state.id}`, state.baseCommit);
    const server = `const http=require('node:http'); const secret=process.env.TEST_PREVIEW_SECRET; process.stdout.write(secret.slice(0,10)); setTimeout(()=>process.stdout.write(secret.slice(10)+'\\n'),20); http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<h1 id="title">Preview ready</h1><button id="show">Show</button><script>document.getElementById("show").addEventListener("click",()=>document.getElementById("title").textContent="Clicked")</script>')}).listen(Number(process.env.PORT),'127.0.0.1');`;
    await writeFile(path.join(state.staging.path, "server.cjs"), server);
    await setSecret("preview-test/shared", "very-secret-preview-value");
    assert((await listSecrets()).includes("preview-test/shared"));
    assert.equal(await getSecret("preview-test/shared"), "very-secret-preview-value");
    const book = await saveCookbook(root, { version: 1, workingDir: ".", setup: [], build: [], start: "node server.cjs", healthPath: "/", variables: {}, secrets: { TEST_PREVIEW_SECRET: "preview-test/shared" } });
    assert.equal((await readCookbook(root))?.start, book.start);
    const info = await startPreview(state, book, []);
    assert.equal(info.status, "healthy");
    const capture = await inspectPreview(state, info);
    assert.match(capture.structure, /Preview ready/);
    const results = await runBrowserSteps(state, info, [{ action: "click", role: "button", name: "Show" }, { action: "expectText", text: "Clicked" }]);
    assert(results?.every((item) => item.status === "passed"), JSON.stringify(results));
    assert(await readFile(info.screenshot!));
    assert.doesNotMatch(info.log, /very-secret-preview-value/);
    await stopPreview(state.id);
    assert.equal(info.status, "stopped");
    const paused = await assert.rejects(() => startPreview(state, { ...book, setup: ["git push origin main"] }, []), PreviewPause);
    void paused;
  } finally {
    if (runId) await stopPreview(runId);
    if (previous === undefined) delete process.env.AGENT_TEAM_DATA_DIR; else process.env.AGENT_TEAM_DATA_DIR = previous;
    await rm(parent, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
