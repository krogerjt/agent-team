import "dotenv/config";
import { loadState } from "./state.js";
import { mergeTeamRun, reviewTeamRun, runTeamGoal } from "./workflow.js";

function value(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${flag}.`);
  return args[index + 1];
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
    for (const task of state.tasks) console.log(`${task.id}: ${task.status}${task.error ? ` | ${task.error}` : ""}`);
    return;
  }
  if (command === "review") {
    const { state, diff } = await reviewTeamRun(value(args, "--run"));
    console.log(`Goal: ${state.goal}\nStatus: ${state.status}\nPlan: ${state.plan?.summary ?? "pending"}`);
    for (const task of state.tasks) {
      console.log(`\n${task.id}: ${task.status} | worktree: ${task.worktree?.path ?? "none"}`);
      if (task.review) console.log(`Review: ${task.review}`);
      if (task.qa) console.log(`QA: ${task.qa}`);
      for (const check of task.checks ?? []) console.log(`${check.name}: ${check.status}`);
      if (task.error) console.log(`Error: ${task.error}`);
    }
    console.log(`\nStaging diff:\n${diff.slice(0, 100_000)}`);
    if (state.status === "awaiting-review") console.log(`\nMerge only after reviewing: npm run team -- merge --run "${state.runDir}"`);
    return;
  }
  if (command === "merge") {
    const state = await mergeTeamRun(value(args, "--run"));
    console.log(`Merged ${state.staging?.branch} into ${state.repo}. No push was performed.`);
    return;
  }
  throw new Error("Usage: npm run team -- run --repo <path> --goal <goal> | status|review|merge --run <run-directory>");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
