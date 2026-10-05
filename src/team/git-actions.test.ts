import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBranchWorktree, git } from "../coding/git.js";
import { tempRepo } from "../coding/test-helpers.js";
import { commitLocalChanges, finishRunUpdate, mergeReadiness, repositoryGitStatus, resolveRunConflict, updateRunToLatest } from "./git-actions.js";
import { loadState, saveState, type TeamRunState } from "./state.js";
import { mergeTeamRun, reviewTeamRun } from "./workflow.js";

async function configureCheck(root: string, exit: number, web = false) {
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "git-test", version: "1.0.0", scripts: { test: `node -e "process.exit(${exit})"`, ...(web ? { dev: "vite" } : {}) } }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ name: "git-test", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "git-test", version: "1.0.0" } } }));
}

async function fixture() {
  const { root, parent } = await tempRepo();
  const baseCommit = await git(root, ["rev-parse", "HEAD"]);
  const id = `git-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const staging = await createBranchWorktree(root, `codex/${id}`, baseCommit);
  const runDir = path.join(parent, "run");
  await mkdir(runDir);
  const state: TeamRunState = { id, repo: root, goal: "Improve note", baseCommit, staging, status: "awaiting-review", tasks: [], runDir, libraryPath: path.join(parent, "library.md") };
  await writeFile(path.join(staging.path, "note.txt"), "team note\n");
  await git(staging.path, ["add", "."]);
  await git(staging.path, ["commit", "-qm", "Team note"]);
  await saveState(state);
  return { root, parent, state, async cleanup() { assert.equal(path.dirname(parent), os.tmpdir()); await rm(parent, { recursive: true, force: true }); } };
}

test("local commit saves only selected files, preserves unrelated staging, and rejects secrets and stale snapshots", async () => {
  const { root, parent } = await tempRepo();
  try {
    await writeFile(path.join(root, "note.txt"), "Unrelated staged change\n");
    await git(root, ["add", "note.txt"]);
    await writeFile(path.join(root, "new file.txt"), "new content\n");
    await writeFile(path.join(root, ".env.production"), "PRIVATE=do-not-show\n");
    const before = await repositoryGitStatus(root);
    assert.equal(before.diff.includes("do-not-show"), false);
    await assert.rejects(commitLocalChanges(root, "Save secret", [".env.production"], before.head), /Keep .env/);
    await assert.rejects(commitLocalChanges(root, "Save arbitrary", ["../outside"], before.head), /Choose files/);
    const result = await commitLocalChanges(root, "Save selected new file", ["new file.txt"], before.head);
    assert.notEqual(result.head, before.head);
    assert.equal(await git(root, ["show", "HEAD:note.txt"]), "hello world");
    assert.equal(await git(root, ["show", "HEAD:new file.txt"]), "new content");
    assert.ok(result.changes.some((file) => file.path === "note.txt" && file.status === "M "));
    await assert.rejects(commitLocalChanges(root, "Stale", ["note.txt"], before.head), /Refresh Git status/);
  } finally { assert.equal(path.dirname(parent), os.tmpdir()); await rm(parent, { recursive: true, force: true }); }
});

test("an older run updates in a preserved worktree and merges after checks without changing the checkout during update", async () => {
  const item = await fixture();
  try {
    await writeFile(path.join(item.root, "latest.txt"), "latest code\n");
    await configureCheck(item.root, 0);
    await git(item.root, ["add", "."]); await git(item.root, ["commit", "-qm", "Advance checkout"]);
    const head = await git(item.root, ["rev-parse", "HEAD"]);
    const readiness = await mergeReadiness(item.state);
    assert.equal(readiness.stale, true); assert.equal(readiness.canMerge, false);
    await assert.rejects(mergeTeamRun(item.state.runDir), /advanced/);
    await writeFile(path.join(item.root, "dirty.txt"), "unsaved");
    await assert.rejects(updateRunToLatest(item.state.runDir, head), /uncommitted/);
    await rm(path.join(item.root, "dirty.txt"));
    await assert.rejects(updateRunToLatest(item.state.runDir, item.state.baseCommit), /Refresh the review/);
    const updated = await updateRunToLatest(item.state.runDir, head);
    assert.equal(updated.integration, undefined); assert.equal(updated.baseCommit, head);
    assert.notEqual(updated.staging!.path, item.state.staging!.path);
    assert.equal(updated.integrationHistory![0].staging.path, item.state.staging!.path);
    assert.equal(updated.integrationChecks![0].status, "passed");
    assert.equal(await git(item.root, ["rev-parse", "HEAD"]), head);
    assert.equal(await readFile(path.join(item.root, "note.txt"), "utf8"), "hello world\n");
    assert.match(await readFile(path.join(item.state.staging!.path, "note.txt"), "utf8"), /team note/);
    assert.equal((await mergeReadiness(updated)).canMerge, true);
    assert.match((await reviewTeamRun(updated.runDir)).diff, /team note/);
    await mergeTeamRun(updated.runDir);
    assert.match(await readFile(path.join(item.root, "note.txt"), "utf8"), /team note/);
    assert.match(await readFile(path.join(item.root, "latest.txt"), "utf8"), /latest code/);
    assert.equal(await git(item.root, ["status", "--porcelain"]), "");
  } finally { await item.cleanup(); }
});

test("conflicts keep merge blocked until a whole-file choice and check rerun", async () => {
  const item = await fixture();
  try {
    await writeFile(path.join(item.root, "note.txt"), "repository note\n");
    await git(item.root, ["add", "."]); await git(item.root, ["commit", "-qm", "Conflicting checkout"]);
    const pending = await updateRunToLatest(item.state.runDir, await git(item.root, ["rev-parse", "HEAD"]));
    assert.ok(pending.integration);
    const readiness = await mergeReadiness(pending);
    assert.equal(readiness.conflicts.length, 1);
    assert.match(readiness.conflicts[0].current, /repository note/);
    assert.match(readiness.conflicts[0].team, /team note/);
    await assert.rejects(mergeTeamRun(pending.runDir), /Finish updating/);
    await assert.rejects(finishRunUpdate(pending.runDir), /remaining conflicts/);
    await assert.rejects(resolveRunConflict(pending.runDir, "../note.txt", "team"), /current conflict/);
    await resolveRunConflict(pending.runDir, "note.txt", "team");
    const updated = await finishRunUpdate(pending.runDir);
    assert.equal((await mergeReadiness(updated)).canMerge, true);
    assert.equal(updated.integrationChecks![0].status, "missing");
    await mergeTeamRun(updated.runDir);
    assert.match(await readFile(path.join(item.root, "note.txt"), "utf8"), /team note/);
  } finally { await item.cleanup(); }
});

test("failed update checks stay blocked and staged repairs are committed before rerunning", async () => {
  const item = await fixture();
  try {
    await configureCheck(item.root, 1);
    await git(item.root, ["add", "."]); await git(item.root, ["commit", "-qm", "Failing check"]);
    const pending = await updateRunToLatest(item.state.runDir, await git(item.root, ["rev-parse", "HEAD"]));
    assert.equal(pending.integration!.checks![0].status, "failed");
    await assert.rejects(mergeTeamRun(pending.runDir), /Finish updating/);
    await writeFile(path.join(pending.integration!.worktree.path, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
    await assert.rejects(finishRunUpdate(pending.runDir), /stage manual edits/);
    await git(pending.integration!.worktree.path, ["add", "package.json"]);
    const updated = await finishRunUpdate(pending.runDir);
    assert.equal(updated.integration, undefined);
    assert.equal(updated.integrationChecks![0].status, "passed");
    assert.equal((await mergeReadiness(updated)).canMerge, true);
    assert.equal(await git(updated.staging!.path, ["status", "--porcelain"]), "");
  } finally { await item.cleanup(); }
});

test("updated web projects require fresh preview review even after checks pass", async () => {
  const item = await fixture();
  try {
    await configureCheck(item.root, 0, true);
    await git(item.root, ["add", "."]); await git(item.root, ["commit", "-qm", "Web configuration"]);
    const updated = await updateRunToLatest(item.state.runDir, await git(item.root, ["rev-parse", "HEAD"]));
    assert.equal(updated.needsPreviewReview, true);
    assert.equal((await mergeReadiness(updated)).canMerge, false);
    await assert.rejects(mergeTeamRun(updated.runDir), /updated preview/);
    assert.equal((await loadState(updated.runDir)).needsPreviewReview, true);
  } finally { await item.cleanup(); }
});
