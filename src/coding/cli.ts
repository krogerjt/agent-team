import "dotenv/config";
import { runCodingTask } from "./workflow.js";

function value(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error(`Usage: npm run code -- --repo <path> --task <goal> (missing ${flag})`);
  }
  return args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repo = value(args, "--repo");
  const task = value(args, "--task");
  const result = await runCodingTask(repo, task);
  console.log(`Worktree: ${result.worktree.path}`);
  console.log(`Branch: ${result.worktree.branch}`);
  console.log(`Research: ${result.research}`);
  console.log(`Review: ${result.review}`);
  console.log(`Repair pass: ${result.repaired ? "yes" : "no"}`);
  console.log("Checks:");
  for (const check of result.checks) console.log(`- ${check.name}: ${check.status}\n${check.output.slice(-2_000)}`);
  console.log(`Diff:\n${result.diff.slice(0, 16_000)}`);
  if (result.checks.some((check) => check.status === "failed")) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
