import { rm } from "node:fs/promises";
import path from "node:path";
import { git } from "../coding/git.js";
import { stopPreview } from "../preview/runtime.js";
import { loadState, repoHome } from "./state.js";

export interface DeletedRun { id: string; removedWorktrees: number; removedBranches: string[] }

async function worktreesOnBranches(repo: string, branches: Set<string>): Promise<string[]> {
  const listing = await git(repo, ["worktree", "list", "--porcelain"]);
  const found: string[] = [];
  for (const block of listing.split(/\r?\n\r?\n/)) {
    const dir = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (dir && branch && branches.has(branch)) found.push(dir);
  }
  return found;
}

/**
 * Throws a run away: stops its preview, removes every worktree and `codex/` branch it created, and deletes its saved
 * state. Code that was already merged into the checkout is untouched. The caller guarantees nothing is still working on it.
 */
export async function deleteTeamRun(runDir: string): Promise<DeletedRun> {
  const state = await loadState(runDir);
  const resolved = path.resolve(runDir);
  if (path.basename(resolved) !== state.id || path.dirname(resolved) !== path.join(repoHome(state.repo), "runs")) throw new Error("This folder is not a saved run.");
  const repo = state.repo;
  await stopPreview(state.id);

  const names = (await git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/codex/"])).split(/\r?\n/).filter((name) => name.includes(state.id));
  const branches = new Set(names);
  if (branches.has(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""))) throw new Error("Your checkout is on one of this run's branches. Switch branches first.");

  const worktrees = await worktreesOnBranches(repo, branches);
  for (const dir of worktrees) {
    try { await git(repo, ["worktree", "remove", "--force", dir]); }
    catch { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
  }
  await git(repo, ["worktree", "prune"]);
  const removedBranches: string[] = [];
  for (const name of branches) {
    try { await git(repo, ["branch", "-D", name]); removedBranches.push(name); } catch { /* already gone */ }
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  return { id: state.id, removedWorktrees: worktrees.length, removedBranches };
}
