import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { git } from "../coding/git.js";
import { roster, type PersonaId } from "../personas/roster.js";
import { loadState, repoHome } from "./state.js";
import { answerTeamRun, mergeTeamRun, messageTeamPersona, reviewTeamRun, runTeamGoal } from "./workflow.js";
import { isPersonaId } from "./persona-store.js";
import { searchTimeline } from "./timeline.js";

function value(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${flag}.`);
  return args[index + 1];
}

function optional(args: string[], flag: string): string | undefined {
  return args.includes(flag) ? value(args, flag) : undefined;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "run") {
    const state = await runTeamGoal(value(args, "--repo"), value(args, "--goal"));
    console.log(`Run: ${state.runDir}\nStatus: ${state.status}\nStaging: ${state.staging?.path ?? "none"}`);
    for (const task of state.tasks) console.log(`${task.id}: ${task.status}${task.worktree ? ` | ${task.worktree.path}` : ""}${task.error ? ` | ${task.error}` : ""}`);
    if (state.status === "awaiting-review") console.log(`Review with: npm run team -- review --run "${state.runDir}"`);
    if (state.status === "blocked") process.exitCode = 1;
    return;
  }
  if (command === "status") {
    const state = await loadState(value(args, "--run"));
    console.log(`Goal: ${state.goal}\nStatus: ${state.status}\nPlan: ${state.plan?.summary ?? "pending"}`);
    if (state.summary) console.log(`Marlow's summary: ${state.summary}`);
    for (const task of state.tasks) console.log(`${task.id}: ${task.status}${task.error ? ` | ${task.error}` : ""}`);
    return;
  }
  if (command === "answer") {
    const state = await answerTeamRun(value(args, "--run"), value(args, "--text"));
    console.log(`Run: ${state.runDir}\nStatus: ${state.status}`);
    for (const task of state.tasks) console.log(`${task.id}: ${task.status}${task.error ? ` | ${task.error}` : ""}`);
    if (state.status === "awaiting-review") console.log(`Review with: npm run team -- review --run "${state.runDir}"`);
    if (state.status === "blocked") process.exitCode = 1;
    return;
  }
  if (command === "ask") {
    const name = value(args, "--persona").toLowerCase();
    if (!Object.hasOwn(roster, name)) throw new Error(`Unknown persona: ${name}. Choose ${Object.keys(roster).join(", ")}.`);
    console.log(await messageTeamPersona(value(args, "--run"), name as PersonaId, value(args, "--message")));
    return;
  }
  if (command === "library") {
    const repo = await git(path.resolve(value(args, "--repo")), ["rev-parse", "--show-toplevel"]);
    try { console.log(await readFile(path.join(repoHome(repo), "library.md"), "utf8")); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") console.log("Library is empty. Notes are added after a reviewed merge.");
      else throw error;
    }
    return;
  }
  if (command === "timeline") {
    const repo = await git(path.resolve(value(args, "--repo")), ["rev-parse", "--show-toplevel"]);
    const persona = value(args, "--persona").toLowerCase();
    if (!isPersonaId(persona)) throw new Error(`Unknown persona: ${persona}.`);
    const result = await searchTimeline(repo, persona, {
      query: optional(args, "--query"), from: optional(args, "--from"), to: optional(args, "--to"),
      feature: optional(args, "--feature"), file: optional(args, "--file"), limit: 25,
    });
    console.log(`${result.total} matching events (showing ${result.entries.length}):`);
    for (const entry of result.entries) console.log(`${entry.at} | ${entry.summary}${entry.feature ? ` | ${entry.feature}` : ""}${entry.files.length ? ` | ${entry.files.join(", ")}` : ""} | ${entry.id}`);
    return;
  }
  if (command === "events") {
    const state = await loadState(value(args, "--run"));
    try { console.log(await readFile(path.join(state.runDir, "events.jsonl"), "utf8")); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") console.log("No events recorded yet.");
      else throw error;
    }
    return;
  }
  if (command === "review") {
    const { state, diff } = await reviewTeamRun(value(args, "--run"));
    console.log(`Goal: ${state.goal}\nStatus: ${state.status}\nPlan: ${state.plan?.summary ?? "pending"}`);
    if (state.summary) console.log(`Marlow's summary: ${state.summary}`);
    for (const task of state.tasks) {
      console.log(`\n${task.id}: ${task.status} | worktree: ${task.worktree?.path ?? "none"}`);
      if (task.review) console.log(`Review: ${task.review}`);
      if (task.qa) console.log(`QA: ${task.qa}`);
      for (const check of task.checks ?? []) console.log(`${check.name}: ${check.status}`);
      if (task.error) console.log(`Error: ${task.error}`);
      if (task.status === "blocked" && task.worktree) console.log(`Uncommitted worker diff: git -C "${task.worktree.path}" diff`);
    }
    console.log(`\nStaging diff:\n${diff.slice(0, 100_000)}`);
    if (state.memoryNote) console.log(`\nTove's pending library note:\n${state.memoryNote}`);
    if (state.status === "awaiting-review") console.log(`\nMerge only after reviewing: npm run team -- merge --run "${state.runDir}"`);
    return;
  }
  if (command === "merge") {
    const state = await mergeTeamRun(value(args, "--run"));
    console.log(`Merged ${state.staging?.branch} into ${state.repo}. No push was performed.`);
    return;
  }
  throw new Error("Usage: npm run team -- run --repo <path> --goal <goal> | status|review|merge|events --run <run-directory> | answer --run <run-directory> --text <guidance> | ask --run <run-directory> --persona <name> --message <text> | library --repo <path> | timeline --repo <path> --persona <name> [--query <text>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--feature <text>] [--file <path>]");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
