import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "../coding/git.js";

export interface RecentRepository { path: string; name: string; openedAt: string }

function settingsPath(): string {
  const root = process.env.AGENT_TEAM_DATA_DIR ? path.resolve(process.env.AGENT_TEAM_DATA_DIR) : path.join(os.homedir(), ".agent-team");
  return path.join(root, "workshop.json");
}

export async function resolveRepository(input: string): Promise<string> {
  const candidate = await realpath(path.resolve(input));
  const root = await git(candidate, ["rev-parse", "--show-toplevel"]);
  const repo = await realpath(root);
  await git(repo, ["rev-parse", "--verify", "HEAD"]);
  return repo;
}

export async function recentRepositories(): Promise<RecentRepository[]> {
  try {
    const value = JSON.parse(await readFile(settingsPath(), "utf8")) as { repositories?: RecentRepository[] };
    if (!Array.isArray(value.repositories)) return [];
    return value.repositories.filter((item) => item && typeof item.path === "string" && typeof item.name === "string" && typeof item.openedAt === "string").slice(0, 12);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    return [];
  }
}

export async function rememberRepository(repo: string): Promise<RecentRepository[]> {
  const current: RecentRepository = { path: repo, name: path.basename(repo), openedAt: new Date().toISOString() };
  const repositories = [current, ...(await recentRepositories()).filter((item) => path.resolve(item.path).toLowerCase() !== path.resolve(repo).toLowerCase())].slice(0, 12);
  const destination = settingsPath();
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ repositories }, null, 2) + "\n", "utf8");
  await rename(temporary, destination);
  return repositories;
}
