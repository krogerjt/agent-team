import { execFile } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 4_000_000, windowsHide: true });
    return stdout.trimEnd();
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : String(error);
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

export async function resolveCleanRepo(input: string): Promise<string> {
  const candidate = await realpath(path.resolve(input));
  const root = await git(candidate, ["rev-parse", "--show-toplevel"]);
  const repo = await realpath(root);
  await git(repo, ["rev-parse", "--verify", "HEAD"]);
  const status = await git(repo, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) throw new Error(`Repository has uncommitted changes. Commit or remove them before running: ${repo}`);
  return repo;
}

export interface Worktree {
  path: string;
  branch: string;
}

export async function createWorktree(repo: string): Promise<Worktree> {
  const container = path.join(path.dirname(repo), ".agent-team-worktrees");
  await mkdir(container, { recursive: true });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const branch = `codex/agent-team-${suffix}`;
  const worktree = path.join(container, `${path.basename(repo)}-${suffix}`);
  await git(repo, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  return { path: worktree, branch };
}

export async function diff(repo: string): Promise<string> {
  const tracked = await git(repo, ["diff", "--no-ext-diff", "--", "."]);
  const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const additions: string[] = [];
  for (const name of untracked) {
    const bytes = await readFile(path.join(repo, name));
    if (bytes.length > 100_000 || bytes.includes(0)) {
      additions.push(`New file: ${name} (binary or over 100 KB; content omitted)`);
      continue;
    }
    const lines = bytes.toString("utf8").replace(/\n$/, "").split(/\r?\n/);
    additions.push(`--- /dev/null\n+++ b/${name.replaceAll("\\", "/")}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`);
  }
  return [tracked, ...additions].filter(Boolean).join("\n\n");
}
