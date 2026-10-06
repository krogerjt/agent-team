import { git } from "../coding/git.js";

const networkTimeout = 120_000;

export interface BranchInfo {
  current: string;
  detached: boolean;
  local: string[];
  /** Remote-tracking branches that have no local branch yet, e.g. "origin/feature". */
  remote: string[];
  remotes: string[];
  upstream?: string;
  ahead: number;
  behind: number;
}

async function tryGit(repo: string, args: string[]): Promise<string | undefined> {
  try { return await git(repo, args); } catch { return undefined; }
}

function lines(output: string): string[] { return output.split("\n").map((line) => line.trim()).filter(Boolean); }

export async function branchInfo(repo: string): Promise<BranchInfo> {
  const current = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const local = lines(await git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]));
  const remotes = lines(await git(repo, ["remote"]));
  const tracking = lines(await git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]))
    .filter((name) => name.includes("/") && !name.endsWith("/HEAD") && remotes.includes(name.split("/")[0]));
  const remote = tracking.filter((name) => !local.includes(name.slice(name.indexOf("/") + 1)));
  const upstream = await tryGit(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  let ahead = 0, behind = 0;
  if (upstream) {
    const counts = await tryGit(repo, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    if (counts) [ahead, behind] = counts.split(/\s+/).map(Number);
  }
  return { current, detached: current === "HEAD", local, remote, remotes, upstream, ahead, behind };
}

async function checkpoint(repo: string, expectedHead: string, action: string): Promise<BranchInfo> {
  if ((await git(repo, ["rev-parse", "HEAD"])) !== expectedHead) throw new Error(`The repository changed. Refresh Git status before ${action}.`);
  if (await git(repo, ["diff", "--name-only", "--diff-filter=U"])) throw new Error(`Resolve the repository's existing merge conflicts before ${action}.`);
  return branchInfo(repo);
}

export async function pullFromRemote(repo: string, expectedHead: string): Promise<string> {
  const info = await checkpoint(repo, expectedHead, "pulling");
  if (info.detached) throw new Error("Switch to a branch before pulling.");
  if (!info.upstream) throw new Error(`${info.current} is not tracking a remote branch. Push it first to set one up.`);
  const output = await git(repo, ["pull", "--ff-only"], { timeout: networkTimeout });
  return output || "Already up to date.";
}

export async function pushToRemote(repo: string, expectedHead: string): Promise<string> {
  const info = await checkpoint(repo, expectedHead, "pushing");
  if (info.detached) throw new Error("Switch to a branch before pushing.");
  if (info.upstream) {
    if (!info.ahead) return "Nothing to push.";
    return git(repo, ["push"], { timeout: networkTimeout });
  }
  if (!info.remotes.length) throw new Error("This repository has no remote. Add one with `git remote add origin <url>` first.");
  const remote = info.remotes.includes("origin") ? "origin" : info.remotes[0];
  if (info.remotes.length > 1 && !info.remotes.includes("origin")) throw new Error("This repository has several remotes and none is named origin. Push once from a terminal to choose one.");
  return git(repo, ["push", "-u", remote, info.current], { timeout: networkTimeout });
}

export async function validBranchName(repo: string, name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 200) throw new Error("Enter a branch name (200 characters maximum).");
  try { return await git(repo, ["check-ref-format", "--branch", trimmed]); }
  catch { throw new Error("That is not a valid Git branch name. Avoid spaces and characters such as ~ ^ : ? * [ \\."); }
}

export async function switchBranch(repo: string, name: string, expectedHead: string): Promise<BranchInfo> {
  const info = await checkpoint(repo, expectedHead, "switching branches");
  if (await git(repo, ["status", "--porcelain", "--untracked-files=no"])) throw new Error("Save your local changes before switching branches.");
  if (name === info.current) return info;
  if (info.local.includes(name)) await git(repo, ["switch", name]);
  else if (info.remote.includes(name)) await git(repo, ["switch", "--track", name]);
  else throw new Error("Choose a branch from the list.");
  return branchInfo(repo);
}

export async function createBranch(repo: string, name: string, expectedHead: string): Promise<BranchInfo> {
  const info = await checkpoint(repo, expectedHead, "creating a branch");
  const branch = await validBranchName(repo, name);
  if (info.local.includes(branch)) throw new Error(`A branch named ${branch} already exists.`);
  // Uncommitted changes carry over to the new branch, as with `git switch -c`.
  await git(repo, ["switch", "-c", branch]);
  return branchInfo(repo);
}
