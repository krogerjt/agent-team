import type { ModelProvider, ToolCapableProvider } from "../core/provider.js";
import { requireToolProvider } from "../core/provider.js";
import { createProvider } from "../config.js";
import { runChecks, type CheckResult } from "../coding/checks.js";
import { createBranchWorktree, diff, git, resolveCleanRepo } from "../coding/git.js";
import { WorkspaceTools } from "../coding/workspace-tools.js";
import { roster, type PersonaId, type WorkerId } from "../personas/roster.js";
import { orderedTasks, parsePlan, type TeamTask } from "./plan.js";
import { appendLibrary, createRunState, loadState, logEvent, readLibrary, saveState, type TaskState, type TeamRunState } from "./state.js";

export type TeamProviders = Record<PersonaId, ModelProvider>;

function defaultProviders(): TeamProviders {
  return {
    marlow: createProvider("marlow"), juniper: createProvider("juniper"),
    kit: createProvider("kit"), wren: createProvider("wren"),
    rowan: createProvider("rowan"), tove: createProvider("tove"),
  };
}

function checksText(checks: CheckResult[]): string {
  return checks.map((check) => `${check.name}: ${check.status}\n${check.output.slice(-3_000)}`).join("\n\n");
}

async function askWithTools(
  state: TeamRunState, persona: PersonaId, provider: ToolCapableProvider,
  prompt: string, tools: WorkspaceTools,
): Promise<string> {
  await logEvent(state, persona, "started", prompt.slice(0, 300));
  const response = await provider.generateWithTools({
    systemPrompt: roster[persona].systemPrompt,
    userPrompt: prompt,
    tools: tools.definitions,
    execute: async (name, args) => {
      await logEvent(state, persona, "tool", `${name} ${JSON.stringify(args).slice(0, 300)}`);
      return tools.execute(name, args);
    },
    maxToolCalls: 20,
    maxRounds: 12,
  });
  await logEvent(state, persona, "finished", `tool calls: ${response.toolCalls}; ${response.text.slice(0, 300)}`);
  if (!response.text.trim()) throw new Error(`${roster[persona].name} returned an empty response.`);
  return response.text.trim();
}

async function evaluateTask(
  state: TeamRunState, task: TeamTask, workerPath: string, changes: string,
  checks: CheckResult[], providers: TeamProviders, library: string,
): Promise<{ review: string; qa: string }> {
  const reviewer: PersonaId = task.worker === "rowan" ? "marlow" : "rowan";
  const context = `Goal: ${state.goal}\nTask: ${task.title}\nShared library:\n${library || "(empty)"}\nDiff:\n${changes.slice(0, 24_000)}\nChecks:\n${checksText(checks)}`;
  const review = await askWithTools(state, reviewer, requireToolProvider(providers[reviewer]),
    `${context}\nReview this worker's changes. Begin with APPROVED: or CHANGES_NEEDED: and give concrete reasons. Do not edit files.`,
    new WorkspaceTools(workerPath, "researcher"));
  const qa = await askWithTools(state, "tove", requireToolProvider(providers.tove),
    `${context}\nCheck task acceptance and verification. Begin with PASS: or ISSUES: and distinguish what checks actually verified. Do not edit files.`,
    new WorkspaceTools(workerPath, "researcher"));
  return { review, qa };
}

function needsRepair(review: string, qa: string, checks: CheckResult[]): boolean {
  return checks.some((check) => check.status === "failed") ||
    !/^APPROVED:/i.test(review.trim()) || !/^PASS:/i.test(qa.trim());
}

async function executeTask(
  state: TeamRunState, task: TeamTask, taskState: TaskState,
  providers: TeamProviders, library: string, answer?: string,
): Promise<boolean> {
  const staging = state.staging!;
  taskState.status = "doing";
  taskState.error = undefined;
  await saveState(state);
  let worktree = taskState.worktree;
  if (!worktree) {
    const branch = `codex/${task.worker}-${state.id}-${task.id}`;
    worktree = await createBranchWorktree(state.repo, branch, staging.branch);
    taskState.worktree = worktree;
    await logEvent(state, task.worker, "worktree", worktree.path);
    await saveState(state);
  }

  let research = taskState.research;
  if (!research) {
    research = await askWithTools(state, "juniper", requireToolProvider(providers.juniper),
      `Goal: ${state.goal}\nAssigned task: ${task.title}\nShared library:\n${library || "(empty)"}\nInspect the relevant repository files and report a concise implementation brief for ${roster[task.worker].name}.`,
      new WorkspaceTools(worktree.path, "researcher"));
    taskState.research = research;
    await saveState(state);
  }

  const worker = requireToolProvider(providers[task.worker]);
  const tools = new WorkspaceTools(worktree.path, "lead");
  const workerResponse = await askWithTools(state, task.worker, worker,
    `Goal: ${state.goal}\nAssigned task: ${task.title}\nOther tasks and dependencies: ${JSON.stringify(state.plan?.tasks)}\nJuniper's brief:\n${research}\nShared library:\n${library || "(empty)"}\n${answer ? `Human answer or guidance: ${answer}\nInspect your existing worktree changes and continue this task.\n` : ""}Implement only this task now, using apply_patch for changes. If a decision is required before proceeding, begin your response with NEEDS_INPUT: and state the exact question.`, tools);
  if (/^NEEDS_INPUT:/i.test(workerResponse)) throw new Error(workerResponse);
  let changes = await diff(worktree.path);
  if (!changes) throw new Error(`${roster[task.worker].name} made no changes for ${task.id}.`);
  let checks = await runChecks(worktree.path);
  taskState.status = "review";
  taskState.checks = checks;
  await logEvent(state, "host", "checks", checks.map((check) => `${check.name}: ${check.status}`).join(", "));
  await saveState(state);
  let { review, qa } = await evaluateTask(state, task, worktree.path, changes, checks, providers, library);

  if (needsRepair(review, qa, checks)) {
    await logEvent(state, task.worker, "repair", `${review.slice(0, 200)} | ${qa.slice(0, 200)}`);
    await askWithTools(state, task.worker, worker,
      `This is the single repair pass for task ${task.title}. Address the review and QA findings with focused patches.\nReview:\n${review}\nQA:\n${qa}\nChecks:\n${checksText(checks)}\nDiff:\n${changes.slice(0, 24_000)}`, tools);
    changes = await diff(worktree.path);
    checks = await runChecks(worktree.path);
    ({ review, qa } = await evaluateTask(state, task, worktree.path, changes, checks, providers, library));
  }
  taskState.review = review;
  taskState.qa = qa;
  taskState.checks = checks;
  await saveState(state);
  if (needsRepair(review, qa, checks)) {
    taskState.status = "blocked";
    taskState.error = "Checks, review, or QA still need attention after one repair pass.";
    await saveState(state);
    return false;
  }

  await git(worktree.path, ["add", "-A"]);
  await git(worktree.path, [
    "-c", `user.name=Agent Team ${roster[task.worker].name}`,
    "-c", "user.email=agent-team@localhost.invalid",
    "commit", "-m", `${roster[task.worker].name}: ${task.title}`,
  ]);
  await git(staging.path, ["merge", "--ff-only", worktree.branch]);
  taskState.status = "done";
  await logEvent(state, task.worker, "integrated", staging.branch);
  await saveState(state);
  return true;
}

async function advanceRun(state: TeamRunState, providers: TeamProviders, library: string, answer?: string): Promise<TeamRunState> {
  state.status = "doing";
  await saveState(state);
  for (const task of orderedTasks(state.plan!)) {
    const taskState = state.tasks.find((item) => item.id === task.id)!;
    if (taskState.status === "done") continue;
    const taskAnswer = taskState.status === "blocked" ? answer : undefined;
    try {
      if (!await executeTask(state, task, taskState, providers, library, taskAnswer)) {
        state.status = "blocked";
        break;
      }
    } catch (error) {
      taskState.status = "blocked";
      taskState.error = error instanceof Error ? error.message : String(error);
      state.status = "blocked";
      await logEvent(state, task.worker, "error", taskState.error);
      break;
    }
  }
  if (state.status !== "blocked") {
    const taskSummary = state.tasks.map((item) => `${item.id}: ${item.status}; checks: ${item.checks?.map((check) => `${check.name} ${check.status}`).join(", ")}; review: ${item.review ?? "none"}; QA: ${item.qa ?? "none"}`).join("\n");
    const finalDiff = await git(state.staging!.path, ["diff", "--no-ext-diff", `${state.baseCommit}..HEAD`, "--", "."]);
    state.summary = (await providers.marlow.generate({
      systemPrompt: roster.marlow.systemPrompt,
      userPrompt: `Summarize the completed goal and what the user should review before merging. Goal: ${state.goal}\nPlan: ${JSON.stringify(state.plan)}\nTasks:\n${taskSummary}\nFinal diff:\n${finalDiff.slice(0, 24_000)}`,
    })).text;
    state.memoryNote = (await providers.tove.generate({
      systemPrompt: roster.tove.systemPrompt,
      userPrompt: `Write concise Markdown memory for future runs. Use the QA findings and final diff below as evidence. Record verified repository conventions, decisions, and remaining uncertainty only. Goal: ${state.goal}\nPlan: ${JSON.stringify(state.plan)}\nTasks:\n${taskSummary}\nFinal diff:\n${finalDiff.slice(0, 24_000)}\nHuman decisions: ${JSON.stringify(state.decisions ?? [])}\nExisting library:\n${library}`,
    })).text;
    state.status = "awaiting-review";
    await logEvent(state, "host", "awaiting-review", state.staging!.path);
  }
  await saveState(state);
  return state;
}

export async function runTeamGoal(repoPath: string, goal: string, injectedProviders?: TeamProviders): Promise<TeamRunState> {
  if (!goal.trim()) throw new Error("Provide a non-empty goal.");
  const repo = await resolveCleanRepo(repoPath);
  const providers = injectedProviders ?? defaultProviders();
  const baseCommit = await git(repo, ["rev-parse", "HEAD"]);
  const state = await createRunState(repo, goal, baseCommit);
  const library = await readLibrary(state);
  try {
    const planText = await askWithTools(state, "marlow", requireToolProvider(providers.marlow),
      `Goal: ${goal}\nShared library:\n${library || "(empty)"}\nInspect repository files, then return ONLY a JSON object with this shape: {"summary":"...","tasks":[{"id":"short-slug","title":"specific coding task","worker":"kit|wren|rowan","dependsOn":[]}]}. Use 1-4 tasks. Assign Kit implementation/tests, Wren user interface work, Rowan refactoring. Keep tasks small, with dependencies listed by ID. Do not assign reviewers or QA as extra tasks.`,
      new WorkspaceTools(repo, "researcher"));
    try {
      state.plan = parsePlan(planText);
    } catch (error) {
      const corrected = await providers.marlow.generate({
        systemPrompt: roster.marlow.systemPrompt,
        userPrompt: `Your previous plan was invalid: ${error instanceof Error ? error.message : String(error)}. Return ONLY corrected JSON with summary and 1-4 tasks. Previous response:\n${planText.slice(0, 8_000)}`,
      });
      state.plan = parsePlan(corrected.text);
    }
    state.tasks = state.plan.tasks.map((task) => ({ id: task.id, status: "todo" }));
    await saveState(state);
    await logEvent(state, "marlow", "plan", JSON.stringify(state.plan));

    state.staging = await createBranchWorktree(repo, `codex/team-${state.id}`, baseCommit);
    const sharedContext = `${library || "(empty)"}\n\nCurrent plan:\n${JSON.stringify(state.plan)}`;
    return await advanceRun(state, providers, sharedContext);
  } catch (error) {
    state.status = "blocked";
    await logEvent(state, "host", "error", error instanceof Error ? error.message : String(error));
    await saveState(state);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nRun state saved at: ${state.runDir}`);
  }
}

export async function answerTeamRun(runDir: string, answer: string, injectedProviders?: TeamProviders): Promise<TeamRunState> {
  if (!answer.trim()) throw new Error("Provide a non-empty answer or guidance.");
  const state = await loadState(runDir);
  if (state.status !== "blocked" || !state.staging || !state.plan) throw new Error("Run has no resumable blocked task.");
  const blocked = state.tasks.find((task) => task.status === "blocked");
  if (!blocked) throw new Error("Run has no blocked task.");
  const repo = await resolveCleanRepo(state.repo);
  if (await git(repo, ["rev-parse", "HEAD"]) !== state.baseCommit) throw new Error("Original checkout has advanced since this run.");
  state.decisions ??= [];
  state.decisions.push({ taskId: blocked.id, answer: answer.trim(), at: new Date().toISOString() });
  await logEvent(state, "user", "answer", `${blocked.id}: ${answer}`);
  await saveState(state);
  const library = await readLibrary(state);
  return advanceRun(state, injectedProviders ?? defaultProviders(), `${library || "(empty)"}\n\nCurrent plan:\n${JSON.stringify(state.plan)}`, answer.trim());
}

export async function messageTeamPersona(runDir: string, persona: PersonaId, message: string, injectedProvider?: ToolCapableProvider): Promise<string> {
  if (!message.trim()) throw new Error("Provide a non-empty message.");
  const state = await loadState(runDir);
  const library = await readLibrary(state);
  const workspace = state.staging?.path ?? state.repo;
  return askWithTools(state, persona, requireToolProvider(injectedProvider ?? createProvider(persona)),
    `User message to ${roster[persona].name}: ${message}\nGoal: ${state.goal}\nCurrent plan: ${JSON.stringify(state.plan ?? null)}\nTask wall: ${JSON.stringify(state.tasks.map((task) => ({ id: task.id, status: task.status })))}\nShared library:\n${library || "(empty)"}\nRespond to the user. You may inspect files, but this direct message cannot edit code.`,
    new WorkspaceTools(workspace, "researcher"));
}

export async function reviewTeamRun(runDir: string): Promise<{ state: TeamRunState; diff: string }> {
  const state = await loadState(runDir);
  const changes = state.staging
    ? await git(state.staging.path, ["diff", "--no-ext-diff", `${state.baseCommit}..HEAD`, "--", "."])
    : "No staging worktree was created.";
  return { state, diff: changes };
}

export async function mergeTeamRun(runDir: string): Promise<TeamRunState> {
  const state = await loadState(runDir);
  if (state.status !== "awaiting-review" || !state.staging) throw new Error("Run is not ready for merge.");
  const repo = await resolveCleanRepo(state.repo);
  if (await git(repo, ["rev-parse", "HEAD"]) !== state.baseCommit) throw new Error("Original checkout has advanced since this run; review and reconcile it first.");
  if (await git(state.staging.path, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("Staging worktree has uncommitted changes.");
  await git(repo, ["merge", "--ff-only", state.staging.branch]);
  state.status = "merged";
  await saveState(state);
  if (state.memoryNote?.trim()) await appendLibrary(state, state.memoryNote);
  await logEvent(state, "host", "merged", state.staging.branch);
  return state;
}
