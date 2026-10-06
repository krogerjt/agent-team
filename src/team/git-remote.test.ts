import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { git } from "../coding/git.js";
import { tempRepo } from "../coding/test-helpers.js";
import { branchInfo, createBranch, pullFromRemote, pushToRemote, switchBranch } from "./git-remote.js";

async function withRemote() {
  const { root, parent } = await tempRepo();
  const bare = path.join(parent, "remote.git");
  await git(parent, ["init", "-q", "--bare", bare]);
  await git(root, ["remote", "add", "origin", bare]);
  const other = path.join(parent, "other");
  return { root, parent, bare, other, async cleanup() { assert.equal(path.dirname(parent), os.tmpdir()); await rm(parent, { recursive: true, force: true }); } };
}
const head = (repo: string) => git(repo, ["rev-parse", "HEAD"]);

test("push sets the upstream on first push, then reports nothing to push", async () => {
  const { root, cleanup } = await withRemote();
  try {
    const before = await branchInfo(root);
    assert.equal(before.upstream, undefined);
    assert.deepEqual(before.remotes, ["origin"]);
    await pushToRemote(root, await head(root));
    const after = await branchInfo(root);
    assert.equal(after.upstream, `origin/${after.current}`);
    assert.equal(await pushToRemote(root, await head(root)), "Nothing to push.");
    await writeFile(path.join(root, "a.txt"), "a\n");
    await git(root, ["add", "."]); await git(root, ["commit", "-qm", "ahead"]);
    assert.equal((await branchInfo(root)).ahead, 1);
    await pushToRemote(root, await head(root));
    assert.equal((await branchInfo(root)).ahead, 0);
    await assert.rejects(pushToRemote(root, "0".repeat(40)), /Refresh Git status/);
  } finally { await cleanup(); }
});

test("pull fast-forwards, reports behind counts, and refuses diverged history", async () => {
  const { root, bare, other, cleanup } = await withRemote();
  try {
    await pushToRemote(root, await head(root));
    await git(root, ["fetch", "-q"]);
    await git(path.dirname(other), ["clone", "-q", bare, other]);
    await git(other, ["config", "user.name", "Other"]); await git(other, ["config", "user.email", "o@example.invalid"]);
    await writeFile(path.join(other, "remote.txt"), "remote\n");
    await git(other, ["add", "."]); await git(other, ["commit", "-qm", "remote change"]); await git(other, ["push", "-q"]);
    await git(root, ["fetch", "-q"]);
    assert.equal((await branchInfo(root)).behind, 1);
    await pullFromRemote(root, await head(root));
    assert.equal(await git(root, ["show", "HEAD:remote.txt"]), "remote");
    assert.equal((await branchInfo(root)).behind, 0);
    assert.equal(await pullFromRemote(root, await head(root)), "Already up to date.");
    // diverge
    await writeFile(path.join(other, "r2.txt"), "r2\n");
    await git(other, ["add", "."]); await git(other, ["commit", "-qm", "r2"]); await git(other, ["push", "-q"]);
    await writeFile(path.join(root, "l2.txt"), "l2\n");
    await git(root, ["add", "."]); await git(root, ["commit", "-qm", "l2"]);
    await git(root, ["fetch", "-q"]);
    await assert.rejects(pullFromRemote(root, await head(root)), /pull failed/);
  } finally { await cleanup(); }
});

test("pull without an upstream and push without a remote explain what to do", async () => {
  const { root, parent } = await tempRepo();
  try {
    await assert.rejects(pullFromRemote(root, await head(root)), /not tracking/);
    await assert.rejects(pushToRemote(root, await head(root)), /no remote/);
  } finally { assert.equal(path.dirname(parent), os.tmpdir()); await rm(parent, { recursive: true, force: true }); }
});

test("create and switch branches, carrying changes only on create, with validation", async () => {
  const { root, bare, other, cleanup } = await withRemote();
  try {
    const original = (await branchInfo(root)).current;
    await writeFile(path.join(root, "note.txt"), "modified\n");
    for (const bad of ["", "has space", "-leading", "a..b", "x~1"]) await assert.rejects(createBranch(root, bad, await head(root)), /branch name|Enter a branch/);
    await assert.rejects(createBranch(root, original, await head(root)), /already exists/);
    const created = await createBranch(root, "feature/login", await head(root));
    assert.equal(created.current, "feature/login");
    assert.ok(created.local.includes(original));
    assert.equal(await git(root, ["status", "--porcelain"]), " M note.txt");
    await assert.rejects(switchBranch(root, original, await head(root)), /Save your local changes/);
    await git(root, ["commit", "-qam", "wip"]);
    await assert.rejects(switchBranch(root, "nope", await head(root)), /Choose a branch/);
    await assert.rejects(switchBranch(root, "--detach", await head(root)), /Choose a branch/);
    assert.equal((await switchBranch(root, original, await head(root))).current, original);
    // remote-only branch becomes a tracking branch
    await pushToRemote(root, await head(root));
    await git(root, ["switch", "-q", "feature/login"]); await pushToRemote(root, await head(root)); await git(root, ["switch", "-q", original]);
    await git(path.dirname(other), ["clone", "-q", bare, other]);
    await git(other, ["config", "user.name", "O"]); await git(other, ["config", "user.email", "o@example.invalid"]);
    await git(other, ["switch", "-q", "-c", "from-other"]); await git(other, ["push", "-q", "-u", "origin", "from-other"]);
    await git(root, ["fetch", "-q"]);
    const info = await branchInfo(root);
    assert.deepEqual(info.remote, ["origin/from-other"]);
    const tracked = await switchBranch(root, "origin/from-other", await head(root));
    assert.equal(tracked.current, "from-other");
    assert.equal(tracked.upstream, "origin/from-other");
  } finally { await cleanup(); }
});
