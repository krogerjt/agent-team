import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBranchWorktree, git } from "../coding/git.js";
import { tempRepo } from "../coding/test-helpers.js";
import { recentRepositories, rememberRepository, resolveRepository } from "./repositories.js";
import { createRunState, saveState } from "../team/state.js";

test("workshop validates and remembers recent Git repositories", async () => {
  const { root, parent } = await tempRepo();
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-team-workshop-"));
  const previous = process.env.AGENT_TEAM_DATA_DIR;
  process.env.AGENT_TEAM_DATA_DIR = data;
  try {
    await mkdir(path.join(root, "src"));
    assert.equal(await resolveRepository(path.join(root, "src")), root);
    await rememberRepository(root);
    await rememberRepository(root);
    const recent = await recentRepositories();
    assert.equal(recent.length, 1);
    assert.equal(recent[0].path, root);
    assert.equal(recent[0].name, path.basename(root));
    await assert.rejects(resolveRepository(data));
    await git(root, ["status", "--short"]);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAM_DATA_DIR; else process.env.AGENT_TEAM_DATA_DIR = previous;
    await rm(parent, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test("Git recovery API commits, updates and merges locally; switching isolates history and rejects stale-tab writes", async () => {
  const first = await tempRepo(), second = await tempRepo();
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-team-switch-"));
  const previous = process.env.AGENT_TEAM_DATA_DIR;
  process.env.AGENT_TEAM_DATA_DIR = data;
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const run = await createRunState(first.root, "First repository only", await git(first.root, ["rev-parse", "HEAD"]));
  run.staging = await createBranchWorktree(first.root, `codex/team-${run.id}`, run.baseCommit);
  await writeFile(path.join(run.staging.path, "note.txt"), "reviewed change\n");
  await git(run.staging.path, ["add", "note.txt"]); await git(run.staging.path, ["commit", "-qm", "Team change"]);
  run.status = "awaiting-review"; await saveState(run);
  const child = spawn(process.execPath, ["--import", "tsx", "src/ui/server.ts", first.root], { cwd: process.cwd(), env: { ...process.env, AGENT_TEAM_PORT: String(port), AGENT_TEAM_DATA_DIR: data }, windowsHide: true, stdio: "ignore" });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const base = `http://127.0.0.1:${port}`;
  try {
    let initial: { repo: string; apiToken: string; runs: Array<{ goal: string }> } | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { const response = await fetch(`${base}/api/bootstrap`); if (response.ok) { initial = await response.json() as typeof initial; break; } } catch { /* server starts asynchronously */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(initial, "server became ready");
    assert.equal(initial.runs[0].goal, "First repository only");
    const post = (endpoint: string, repo: string, body: unknown) => fetch(base + endpoint, { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Team-Token": initial!.apiToken, "X-Agent-Team-Repository": encodeURIComponent(repo) }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${base}/api/git/commit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 400);
    await writeFile(path.join(first.root, "local.txt"), "my local work\n");
    const reviewPath = `/api/runs/${run.id}/review`;
    const dirtyReview = await fetch(base + reviewPath).then((response) => response.json()) as { readiness: { canMerge: boolean; reasons: string[] } };
    assert.equal(dirtyReview.readiness.canMerge, false);
    assert.match(dirtyReview.readiness.reasons.join(" "), /unsaved/);
    const saved = await post("/api/git/commit", first.root, { head: run.baseCommit, message: "Save local work", files: ["local.txt"] });
    assert.equal(saved.status, 200, await saved.clone().text());
    const status = await saved.json() as { head: string; changes: unknown[] };
    assert.equal(status.changes.length, 0);
    assert.equal((await post(`/api/runs/${run.id}/merge`, first.root, {})).status, 400);
    const update = await post(`/api/runs/${run.id}/update`, first.root, { head: status.head });
    assert.equal(update.status, 202, await update.clone().text());
    const { jobId } = await update.json() as { jobId: string };
    let job: { status: string; error?: string } = { status: "running" };
    for (let attempt = 0; attempt < 80 && job.status === "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await fetch(`${base}/api/jobs/${jobId}`).then((response) => response.json()) as typeof job;
    }
    assert.equal(job.status, "done", job.error ?? "update completed");
    assert.match(await readFile(path.join(first.root, "note.txt"), "utf8"), /hello world/);
    const readyReview = await fetch(base + reviewPath).then((response) => response.json()) as { readiness: { canMerge: boolean }; diff: string };
    assert.equal(readyReview.readiness.canMerge, true); assert.match(readyReview.diff, /reviewed change/);
    assert.equal((await post(`/api/runs/${run.id}/merge`, first.root, {})).status, 200);
    assert.match(await readFile(path.join(first.root, "note.txt"), "utf8"), /reviewed change/);
    assert.match(await readFile(path.join(first.root, "local.txt"), "utf8"), /my local work/);
    assert.equal((await post("/api/repositories/select", initial.repo, { path: data })).status, 400);
    assert.equal((await post("/api/repositories/select", initial.repo, { path: second.root })).status, 200);
    const selected = await fetch(`${base}/api/bootstrap`).then((response) => response.json()) as { repo: string; runs: unknown[]; repositories: unknown[] };
    assert.equal(selected.repo, second.root);
    assert.equal(selected.runs.length, 0);
    assert.equal(selected.repositories.length, 2);
    const stale = await post("/api/repositories/select", initial.repo, { path: first.root });
    assert.equal(stale.status, 400);
    assert.match(await stale.text(), /another tab/);
    assert.equal((await post("/api/repositories/select", selected.repo, { path: first.root })).status, 200);
    const restored = await fetch(`${base}/api/bootstrap`).then((response) => response.json()) as typeof initial;
    assert.equal(restored.runs[0].goal, "First repository only");
  } finally {
    child.kill(); await closed;
    if (previous === undefined) delete process.env.AGENT_TEAM_DATA_DIR; else process.env.AGENT_TEAM_DATA_DIR = previous;
    await rm(first.parent, { recursive: true, force: true });
    await rm(second.parent, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
