import type { ModelProvider, ToolCapableProvider } from "../core/provider.js";
import { requireToolProvider } from "../core/provider.js";
import { createProvider, toolLoopLimits } from "../config.js";
import { runChecks, type CheckResult } from "./checks.js";
import { createWorktree, diff, resolveCleanRepo, type Worktree } from "./git.js";
import { WorkspaceTools } from "./workspace-tools.js";

export interface CodingResult {
  worktree: Worktree;
  research: string;
  review: string;
  checks: CheckResult[];
  diff: string;
  repaired: boolean;
}

export interface CodingProviders {
  researcher: ModelProvider;
  lead: ModelProvider;
  reviewer: ModelProvider;
}

function checksText(checks: CheckResult[]): string {
  return checks.map((check) => `${check.name}: ${check.status}\n${check.output.slice(-4_000)}`).join("\n\n");
}

function toolRequest(provider: ToolCapableProvider, systemPrompt: string, userPrompt: string, tools: WorkspaceTools) {
  return provider.generateWithTools({
    systemPrompt,
    userPrompt,
    tools: tools.definitions,
    execute: (name, args) => tools.execute(name, args),
    ...toolLoopLimits(),
  });
}

export async function runCodingTask(repoPath: string, task: string, providers: CodingProviders = {
  researcher: createProvider("researcher"),
  lead: createProvider("lead"),
  reviewer: createProvider("reviewer"),
}): Promise<CodingResult> {
  if (!task.trim()) throw new Error("Provide a non-empty coding task.");
  const repo = await resolveCleanRepo(repoPath);
  const worktree = await createWorktree(repo);
  const researchTools = new WorkspaceTools(worktree.path, "researcher");
  const leadTools = new WorkspaceTools(worktree.path, "lead");
  const reviewerTools = new WorkspaceTools(worktree.path, "researcher");
  try {
    const research = await toolRequest(requireToolProvider(providers.researcher),
      "You are the Researcher. Inspect the repository using tools. Identify the files and behavior relevant to the coding task. Report a concise implementation approach with risks. Do not edit files or claim to have inspected files you did not read.",
      `Task: ${task}\nUse the tools to inspect the repository before answering.`, researchTools);
    const lead = requireToolProvider(providers.lead);
    await toolRequest(lead,
      "You are the Lead engineer. Use repository tools to inspect and implement the task. Apply focused text patches. Do not claim success unless you changed the required files. Do not run commands; the host will run checks after your edits.",
      `Task: ${task}\nResearcher's findings:\n${research.text}\nImplement the task now.`, leadTools);
    let changes = await diff(worktree.path);
    if (!changes) throw new Error("Lead made no changes.");
    let checks = await runChecks(worktree.path, { repo });
    const reviewer = requireToolProvider(providers.reviewer);
    const review = await toolRequest(reviewer,
      "You are the Reviewer. Inspect the changed code as needed. Evaluate correctness, edge cases, and the check results. Start your answer with APPROVED: or CHANGES_NEEDED: and give concrete reasons. Do not edit files.",
      `Task: ${task}\nDiff:\n${changes.slice(0, 24_000)}\nChecks:\n${checksText(checks)}`, reviewerTools);
    let repaired = false;
    if (checks.some((check) => check.status === "failed") || /^CHANGES_NEEDED:/i.test(review.text.trim())) {
      repaired = true;
      await toolRequest(lead,
        "You are the Lead engineer. Repair the implementation using the repository tools. Address the reviewer and failed checks. Apply patches only; do not run commands. This is the final repair pass.",
        `Task: ${task}\nReview:\n${review.text}\nChecks:\n${checksText(checks)}\nCurrent diff:\n${changes.slice(0, 24_000)}`, leadTools);
      changes = await diff(worktree.path);
      checks = await runChecks(worktree.path, { repo });
    }
    return { worktree, research: research.text, review: review.text, checks, diff: changes, repaired };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nWorktree preserved at: ${worktree.path}`);
  }
}
