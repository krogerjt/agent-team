import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorktree, git, resolveCleanRepo } from "./git.js";
import { tempRepo } from "./test-helpers.js";

const cleanup: string[] = [];
after(async () => {
  for (const target of cleanup) {
    assert.equal(path.dirname(target), os.tmpdir());
    await rm(target, { recursive: true, force: true });
  }
});

test("creates an isolated worktree and rejects dirty input", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push(parent);
  assert.equal(await resolveCleanRepo(root), root);
  const worktree = await createWorktree(root);
  assert.match(worktree.branch, /^codex\/agent-team-/);
  assert.equal((await git(worktree.path, ["rev-parse", "--show-toplevel"])).replaceAll("\\", "/"), worktree.path.replaceAll("\\", "/"));
  await writeFile(path.join(root, "note.txt"), "dirty\n");
  await assert.rejects(() => resolveCleanRepo(root), /uncommitted changes/);
});
