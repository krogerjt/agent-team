import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CheckResult } from "../coding/checks.js";
import type { Worktree } from "../coding/git.js";
import type { TeamPlan } from "./plan.js";

export type TaskStatus = "todo" | "doing" | "review" | "done" | "blocked";
export type RunStatus = "planning" | "doing" | "awaiting-review" | "blocked" | "merged";

export interface TaskState {
  id: string;
  status: TaskStatus;
  worktree?: Worktree;
  research?: string;
  review?: string;
  qa?: string;
  checks?: CheckResult[];
  error?: string;
}

export interface TeamRunState {
  id: string;
  repo: string;
  goal: string;
  baseCommit: string;
  status: RunStatus;
  staging?: Worktree;
  plan?: TeamPlan;
  tasks: TaskState[];
  decisions?: Array<{ taskId: string; answer: string; at: string }>;
  summary?: string;
  memoryNote?: string;
  libraryPath: string;
  runDir: string;
}

export function repoHome(repo: string): string {
  const hash = createHash("sha256").update(path.resolve(repo).toLowerCase()).digest("hex").slice(0, 12);
  return path.join(os.homedir(), ".agent-team", "repos", `${path.basename(repo)}-${hash}`);
}

export async function createRunState(repo: string, goal: string, baseCommit: string): Promise<TeamRunState> {
  const home = repoHome(repo);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const runDir = path.join(home, "runs", id);
  await mkdir(runDir, { recursive: true });
  const state: TeamRunState = {
    id, repo, goal, baseCommit, status: "planning", tasks: [],
    libraryPath: path.join(home, "library.md"), runDir,
  };
  await saveState(state);
  return state;
}

export async function saveState(state: TeamRunState): Promise<void> {
  const destination = path.join(state.runDir, "state.json");
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2) + "\n");
  await rename(temporary, destination);
}

export async function loadState(runDir: string): Promise<TeamRunState> {
  return JSON.parse(await readFile(path.join(path.resolve(runDir), "state.json"), "utf8")) as TeamRunState;
}

export async function readLibrary(state: TeamRunState): Promise<string> {
  try { return (await readFile(state.libraryPath, "utf8")).slice(-40_000); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

export async function appendLibrary(state: TeamRunState, note: string): Promise<void> {
  await mkdir(path.dirname(state.libraryPath), { recursive: true });
  await appendFile(state.libraryPath, `\n## Run ${state.id}\n\n${note.trim()}\n`, "utf8");
}

export async function logEvent(state: TeamRunState, persona: string, event: string, detail: string): Promise<void> {
  await appendFile(path.join(state.runDir, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), persona, event, detail: detail.slice(0, 2_000) }) + "\n");
}
