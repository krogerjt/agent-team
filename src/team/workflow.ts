import type { ModelProvider, ToolCapableProvider } from "../core/provider.js";
import { requireToolProvider } from "../core/provider.js";
import { runChecks, type CheckResult } from "../coding/checks.js";
import { createBranchWorktree, diff, git, resolveCleanRepo, type Worktree } from "../coding/git.js";
import { WorkspaceTools } from "../coding/workspace-tools.js";
import { capabilityList, roster, WORKER_IDS, WRITING_WORKERS, type PersonaId } from "../personas/roster.js";
import { MAX_PLAN_TASKS, MAX_TASK_TITLE, parsePlan, type TeamTask } from "./plan.js";
import { appendLibrary, createRunState, loadState, logEvent, readLibrary, repoHome, saveState, type ReleaseStageState, type TaskState, type TeamRunState } from "./state.js";
import { appendChat, configuredProvider, effectiveModel, personaContext, readPersona } from "./persona-store.js";
import { readToolLoopDiagnostics, trackedGenerate, trackedGenerateWithTools } from "./telemetry.js";
import { appendTimeline, ensureTimeline, executeMemoryTool, memoryTools } from "./timeline.js";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractCookbook, readCookbook, saveCookbook, type Cookbook } from "../preview/cookbook.js";
import { livePreview, startPreview, stopPreview, PreviewFailure, PreviewPause, PreviewStopped, type PreviewInfo } from "../preview/runtime.js";
import { inspectPreview, runBrowserSteps, screenshotData, type BrowserStep } from "../preview/browser.js";
import { buildEnvironmentTools, executeBuildEnvironmentTool } from "./environment-tools.js";
import { createHollisSession } from "../ios/hollis-session.js";
import { goalMentionsRelease, isIosApp } from "../ios/release-trigger.js";
import { redactSecrets } from "../ios/redact.js";
import { maxDecisions, toolLoopLimits } from "../config.js";
import { serialize } from "./serial.js";
import { initDirector, runDirector } from "./director.js";

/** Hollis (iOS release engineer) is optional so existing provider sets stay valid. */
export type TeamProviders = Record<Exclude<PersonaId, "hollis">, ModelProvider> & { hollis?: ModelProvider };
const stopPreviewTool = { name: "stop_preview", description: "Stop the local preview for this run when it is no longer needed.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } };
const startPreviewTool = { name: "start_preview", description: "Start or inspect the staged web preview. The host follows Piper's cookbook and waits for it to become healthy.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } };

/** A release is many slow Mac operations in a row, so Hollis gets three times the usual loop budget. */
function hollisLimits(): { maxToolCalls: number; maxRounds: number } {
  const limits = toolLoopLimits();
  return { maxToolCalls: limits.maxToolCalls * 3, maxRounds: limits.maxRounds * 3 };
}

async function generateFor(state: TeamRunState, persona: PersonaId, provider: ModelProvider, request: Parameters<ModelProvider["generate"]>[0]) {
  return trackedGenerate(state.repo, persona, await effectiveModel(state.repo, persona), provider, request);
}

export async function generateToolsFor(state: TeamRunState, persona: PersonaId, provider: ToolCapableProvider, request: Parameters<ToolCapableProvider["generateWithTools"]>[0], journalWork = true) {
  try {
    return await trackedGenerateWithTools(state.repo, persona, await effectiveModel(state.repo, persona), provider, request);
  } catch (error) {
    const diagnostics = readToolLoopDiagnostics(error);
    if (diagnostics) {
      const toolsUsed = diagnostics.calls.map((call) => `#${call.round} ${call.name}`).join(" → ") || "none";
      const lastCalls = diagnostics.calls.slice(-6).map((call) => `${call.name}(${JSON.stringify(call.args).slice(0, 180)})`).join(" | ") || "none";
      const detail = `${error instanceof Error ? error.message : String(error)}\nTools tried (${diagnostics.calls.length}): ${toolsUsed}\nLast call arguments: ${lastCalls}\nBottleneck: ${diagnostics.bottleneck ?? "unknown"}`;
      if (journalWork) await recordRunEvent(state, persona, "budget-exhausted", detail, { summary: `${roster[persona].name} hit a loop budget` });
      else await logEvent(state, persona, "budget-exhausted", detail);
    }
    throw error;
  }
}

export async function defaultProviders(repo: string): Promise<TeamProviders> {
  const entries = await Promise.all((Object.keys(roster) as PersonaId[]).map(async (id) => [id, await configuredProvider(repo, id)] as const));
  return Object.fromEntries(entries) as TeamProviders;
}

export function checksText(checks: CheckResult[]): string {
  return checks.map((check) => `${check.name}: ${check.status}\n${check.output.slice(-3_000)}`).join("\n\n");
}

export async function recordRunEvent(
  state: TeamRunState, persona: PersonaId, event: string, detail: string,
  options: { summary?: string; taskId?: string; files?: string[] } = {},
): Promise<void> {
  await ensureTimeline(state.repo);
  const task = options.taskId
    ? state.plan?.tasks.find((item) => item.id === options.taskId)
    : state.plan?.tasks.find((item) => state.tasks.some((status) => status.id === item.id && (status.status === "doing" || status.status === "review")));
  await logEvent(state, persona, event, detail);
  await appendTimeline(state.repo, persona, {
    at: new Date().toISOString(), event,
    summary: options.summary ?? `${roster[persona].name} ${event}: ${detail}`,
    detail, feature: task?.title ?? state.goal,
    files: options.files ?? [], runId: state.id, taskId: task?.id, source: "run",
  });
}

export async function askWithTools(
  state: TeamRunState, persona: PersonaId, provider: ToolCapableProvider,
  prompt: string, tools: WorkspaceTools, journalWork = true, taskId?: string, hollisMode?: "full" | "readiness",
): Promise<string> {
  const personal = await personaContext(state.repo, persona);
  const writable = tools.definitions.some((tool) => tool.name === "apply_patch");
  const activeTitle = state.plan?.tasks.find((task) => taskId ? task.id === taskId : state.tasks.some((item) => item.id === task.id && (item.status === "doing" || item.status === "review")))?.title ?? state.goal;
  if (journalWork) await recordRunEvent(state, persona, "started", prompt.slice(0, 300), { taskId, summary: `${roster[persona].name} started ${activeTitle}` });
  else await logEvent(state, persona, "started", prompt.slice(0, 300));
  const hollis = persona === "hollis" ? createHollisSession({ repo: state.repo, root: tools.root, writable: writable || tools.root !== state.repo, runDir: state.runDir, mode: hollisMode }) : undefined;
  const response = await generateToolsFor(state, persona, provider, {
    systemPrompt: `${roster[persona].systemPrompt}\n${personal}`,
    userPrompt: prompt,
    tools: hollis ? [...hollis.definitions, ...memoryTools] : [...tools.definitions, ...memoryTools, ...buildEnvironmentTools(writable), stopPreviewTool, ...(state.tasks.length && state.tasks.every((task) => task.status === "done") && persona !== "piper" ? [startPreviewTool] : [])],
    execute: async (name, args) => {
      if (name === "stop_preview") { await stopPreview(state.id); if (state.preview) { state.preview.status = "stopped"; state.preview.url = undefined; await saveState(state); } return { content: "Preview stopped." }; }
      if (name === "start_preview") {
        if (!state.tasks.length || !state.tasks.every((task) => task.status === "done") || persona === "piper") return { content: "Preview becomes available after the staged build is complete.", isError: true };
        if (livePreview(state.id)?.status === "healthy") return { content: `Preview healthy: ${state.preview?.url}` };
        const info = await obtainPreview(state, await configuredProvider(state.repo, "piper"));
        return { content: info?.url ? `Preview healthy: ${info.url}` : `Preview paused: ${state.preview?.issue ?? "unknown reason"}`, isError: !info };
      }
      if (name === "search_memory" || name === "get_memory_entry") {
        await logEvent(state, persona, "memory-lookup", `${name} ${JSON.stringify(args).slice(0, 300)}`);
        return executeMemoryTool(state.repo, persona, name, args);
      }
      if (journalWork) await recordRunEvent(state, persona, "tool", `${name} ${JSON.stringify(args).slice(0, 300)}`, {
        taskId, summary: `${roster[persona].name} used ${name}${typeof args.path === "string" ? ` on ${args.path}` : ""}`,
        files: typeof args.path === "string" ? [args.path] : [],
      });
      else await logEvent(state, persona, "tool", `${name} ${JSON.stringify(args).slice(0, 300)}`);
      if (hollis) { const result = await hollis.execute(name, args); if (result) return result; }
      if (name === "inspect_build_environment" || name === "run_checks") return executeBuildEnvironmentTool(name, tools.root, state.repo, writable, { runDir: state.runDir, taskId: taskId ?? state.tasks.find((task) => task.status === "doing")?.id });
      return tools.execute(name, args);
    },
    ...(hollis ? hollisLimits() : toolLoopLimits()),
  }, journalWork);
  if (journalWork) await recordRunEvent(state, persona, "responded", `tool calls: ${response.toolCalls}; ${response.text.slice(0, 1_500)}`, { taskId, summary: `${roster[persona].name} returned findings for ${activeTitle}; acceptance checks are separate` });
  else await logEvent(state, persona, "responded", `tool calls: ${response.toolCalls}; ${response.text.slice(0, 300)}`);
  if (!response.text.trim()) throw new Error(`${roster[persona].name} returned an empty response.`);
  return response.text.trim();
}

/** The provider for a persona, or a plain error Marlow can act on when none is configured. */
export function providerFor(providers: TeamProviders, persona: PersonaId): ToolCapableProvider {
  const provider = providers[persona as keyof TeamProviders];
  if (!provider) throw new Error(`${roster[persona].name} has no model provider configured (set ${persona.toUpperCase()}_PROVIDER and ${persona.toUpperCase()}_MODEL).`);
  return requireToolProvider(provider);
}

export function planTask(state: TeamRunState, taskId: string): TeamTask {
  const task = state.plan?.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`There is no task "${taskId}".`);
  return task;
}

export function taskStateOf(state: TeamRunState, taskId: string): TaskState {
  let taskState = state.tasks.find((item) => item.id === taskId);
  if (!taskState) { taskState = { id: taskId, status: "todo" }; state.tasks.push(taskState); }
  return taskState;
}

/** Checks that failed, or required checks that could not run. */
export function failingChecks(checks?: CheckResult[]): CheckResult[] {
  return (checks ?? []).filter((check) => check.status === "failed" || check.required && check.status === "missing");
}

export function checksLine(checks?: CheckResult[]): string {
  return checks?.length ? checks.map((check) => `${check.name} ${check.status}${check.required && check.status === "missing" ? " (required)" : ""}`).join(", ") : "none run";
}

function countFailure(taskState: TaskState, persona: PersonaId): void {
  taskState.failures ??= {};
  taskState.failures[persona] = (taskState.failures[persona] ?? 0) + 1;
}

async function ensureWorktree(state: TeamRunState, task: TeamTask, taskState: TaskState): Promise<Worktree> {
  if (taskState.worktree) return taskState.worktree;
  const worktree = await createBranchWorktree(state.repo, `codex/${task.worker}-${state.id}-${task.id}`, state.staging!.branch);
  taskState.worktree = worktree;
  await recordRunEvent(state, task.worker, "worktree", worktree.path, { taskId: task.id, summary: `Opened a worktree for ${task.title}` });
  await saveState(state);
  return worktree;
}

/** What review, QA and checks said last time, for a worker who is sent back or takes a task over. */
function previousFindings(taskState: TaskState): string {
  const parts = [
    taskState.review ? `Last review${taskState.reviewer ? ` (${taskState.reviewer})` : ""}:\n${taskState.review.slice(0, 4_000)}` : "",
    taskState.qa ? `Last QA:\n${taskState.qa.slice(0, 4_000)}` : "",
    taskState.checks?.length ? `Last checks:\n${checksText(taskState.checks).slice(0, 4_000)}` : "",
    taskState.error ? `Last attempt ended with: ${taskState.error.slice(0, 2_000)}` : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join("\n")}\n` : "";
}

/** A read-only question to any teammate (Juniper by default). With a task, the answer becomes that task's brief. */
export async function researchStep(state: TeamRunState, providers: TeamProviders, library: string, persona: PersonaId, question: string, taskId?: string): Promise<string> {
  const task = taskId ? planTask(state, taskId) : undefined;
  const taskState = taskId ? taskStateOf(state, taskId) : undefined;
  const answer = await askWithTools(state, persona, providerFor(providers, persona),
    `Goal: ${state.goal}\n${task ? `Task: ${task.title} (worker: ${roster[task.worker].name})\n` : ""}Shared library:\n${library || "(empty)"}\nMarlow, the lead, asks: ${question}\nInspect what you need and answer concisely${task ? ` as an implementation brief for ${roster[task.worker].name}` : ""}. Say what you verified and what you are assuming. Do not edit files.`,
    new WorkspaceTools(taskState?.worktree?.path ?? state.staging!.path, "researcher"), true, taskId, "readiness");
  if (taskState) {
    taskState.research = taskState.research ? `${taskState.research}\n\n${roster[persona].name}: ${answer}` : answer;
    await saveState(state);
  }
  return answer;
}

/**
 * The task's worker does (or continues) the task in its own worktree, then the host runs checks on any changes.
 * Failures count against the worker and are thrown for Marlow to decide on; the task waits in "review" either way.
 */
export async function workStep(state: TeamRunState, providers: TeamProviders, library: string, taskId: string, guidance?: string): Promise<string> {
  const task = planTask(state, taskId);
  const taskState = taskStateOf(state, taskId);
  const persona = task.worker;
  const previous = guidance ? previousFindings(taskState) : "";
  taskState.status = "doing";
  taskState.error = undefined;
  taskState.triageNote = undefined;
  await saveState(state);
  try {
    const worktree = await ensureWorktree(state, task, taskState);
    if (task.research && !taskState.research) await researchStep(state, providers, library, "juniper", `Write a concise implementation brief for "${task.title}".`, task.id);
    const writes = WRITING_WORKERS.includes(persona);
    const reply = await askWithTools(state, persona, providerFor(providers, persona),
      `Goal: ${state.goal}\nAssigned task: ${task.title}\nOther tasks and dependencies: ${JSON.stringify(state.plan?.tasks)}\n${taskState.research ? `Research brief:\n${taskState.research}\n` : ""}Shared library:\n${library || "(empty)"}\n${guidance ? `Guidance from Marlow, the lead: ${guidance}\n${previous}Inspect your existing worktree changes and continue this task.\n` : ""}${writes
        ? "Tasks that do not depend on yours may be running at the same time in their own worktrees, so stay strictly inside this task's scope and avoid unrelated edits or reformatting. Implement only this task now, using apply_patch for changes."
        : "You cannot edit files in this session. Do the task with your own tools and report exactly what you verified, with evidence, and what you found."} If the task needs a tool you do not have, or a decision before you can proceed, begin your response with NEEDS_INPUT: and say exactly what is missing, so Marlow can reassign it or decide.`,
      new WorkspaceTools(worktree.path, writes ? "lead" : "researcher"), true, task.id, "readiness");
    taskState.notes = reply.slice(0, 6_000);
    if (/^NEEDS_INPUT:/i.test(reply)) throw new Error(reply);
    const changes = await diff(worktree.path);
    taskState.hasChanges = Boolean(changes);
    taskState.review = undefined;
    taskState.reviewer = undefined;
    taskState.qa = undefined;
    taskState.checks = undefined;
    if (!changes && writes) throw new Error(`${roster[persona].name} made no changes for ${task.id}.`);
    if (changes) {
      const checks = await runChecks(worktree.path, { repo: state.repo, runDir: state.runDir, taskId: task.id });
      taskState.checks = checks;
      await recordRunEvent(state, persona, "checks", checksText(checks), { taskId: task.id, summary: `Checked ${task.title}: ${checksLine(checks)}` });
      if (failingChecks(checks).length) countFailure(taskState, persona);
    }
    taskState.status = "review";
    await saveState(state);
    return `${roster[persona].name} finished "${task.title}".\nTheir reply: ${reply.slice(0, 2_000)}\n${changes ? `Diff (${changes.length} characters):\n${changes.slice(0, 6_000)}\nChecks:\n${checksText(taskState.checks ?? []).slice(0, 3_000) || "none detected"}` : "No file changes."}`;
  } catch (error) {
    taskState.status = "review";
    taskState.error = error instanceof Error ? error.message : String(error);
    countFailure(taskState, persona);
    await saveState(state);
    throw error;
  }
}

function verdictContext(state: TeamRunState, task: TeamTask, taskState: TaskState, changes: string, library: string): string {
  return `Goal: ${state.goal}\nTask: ${task.title} (done by ${roster[task.worker].name})\nShared library:\n${library || "(empty)"}\nDiff:\n${changes.slice(0, 24_000) || "(no file changes)"}\nChecks:\n${checksText(taskState.checks ?? []) || "none run"}\nWorker's report:\n${taskState.notes?.slice(0, 3_000) ?? "(none)"}`;
}

/** A teammate other than the worker reviews the task's changes. A rejection counts against the worker. */
export async function reviewStep(state: TeamRunState, providers: TeamProviders, library: string, taskId: string, reviewer: PersonaId): Promise<string> {
  const task = planTask(state, taskId);
  const taskState = taskStateOf(state, taskId);
  const changes = taskState.worktree ? await diff(taskState.worktree.path) : "";
  const review = await askWithTools(state, reviewer, providerFor(providers, reviewer),
    `${verdictContext(state, task, taskState, changes, library)}\nReview this worker's changes. Begin with APPROVED: or CHANGES_NEEDED: and give concrete reasons. Do not edit files.`,
    new WorkspaceTools(taskState.worktree?.path ?? state.staging!.path, "researcher"), true, task.id, "readiness");
  taskState.review = review;
  taskState.reviewer = roster[reviewer].name;
  if (!/^APPROVED:/i.test(review.trim())) countFailure(taskState, task.worker);
  await saveState(state);
  return `${roster[reviewer].name} reviewed "${task.title}":\n${review.slice(0, 4_000)}`;
}

/** QA (Tove by default) checks the task against its goal. Issues count against the worker. */
export async function qaStep(state: TeamRunState, providers: TeamProviders, library: string, taskId: string, persona: PersonaId): Promise<string> {
  const task = planTask(state, taskId);
  const taskState = taskStateOf(state, taskId);
  const changes = taskState.worktree ? await diff(taskState.worktree.path) : "";
  const qa = await askWithTools(state, persona, providerFor(providers, persona),
    `${verdictContext(state, task, taskState, changes, library)}\nCheck task acceptance and verification. Begin with PASS: or ISSUES: and distinguish what checks actually verified. Do not edit files.`,
    new WorkspaceTools(taskState.worktree?.path ?? state.staging!.path, "researcher"), true, task.id, "readiness");
  taskState.qa = qa;
  if (!/^PASS:/i.test(qa.trim())) countFailure(taskState, task.worker);
  await saveState(state);
  return `${roster[persona].name} checked "${task.title}":\n${qa.slice(0, 4_000)}`;
}

/**
 * Merge the task into the run's staging branch (never the human's checkout), one task at a time so staging only
 * advances by fast-forward. Work landed by parallel tasks is folded in first and the combined code re-checked;
 * combined failures stop the merge unless Marlow accepted failing checks for this task.
 */
export async function integrateStep(state: TeamRunState, providers: TeamProviders, taskId: string, acceptFailingChecks: boolean): Promise<string> {
  const task = planTask(state, taskId);
  const taskState = taskStateOf(state, taskId);
  const staging = state.staging!;
  const worktree = taskState.worktree;
  if (!worktree || !await diff(worktree.path)) {
    taskState.status = "done";
    await recordRunEvent(state, task.worker, "integrated", "No file changes to merge.", { taskId: task.id, summary: `Completed ${task.title} (nothing to merge)` });
    await saveState(state);
    return `"${task.title}" is done. It had no file changes, so nothing was merged.`;
  }
  const resolver: PersonaId = WRITING_WORKERS.includes(task.worker) ? task.worker : "kit";
  const tools = new WorkspaceTools(worktree.path, "lead");
  let checks = taskState.checks ?? [];
  const identity = ["-c", `user.name=Agent Team ${roster[task.worker].name}`, "-c", "user.email=agent-team@localhost.invalid"];
  const combined = await serialize(`integrate:${state.id}`, async () => {
    await git(worktree.path, ["add", "-A"]);
    await git(worktree.path, [...identity, "commit", "-m", `${roster[task.worker].name}: ${task.title}`]);
    const taskCommit = await git(worktree.path, ["rev-parse", "HEAD"]);
    // Keep the task's changes in the worktree (uncommitted) when integration fails, so a retry still sees them.
    const uncommit = async () => { await git(worktree.path, ["reset", "--hard", taskCommit]).catch(() => undefined); await git(worktree.path, ["reset", "--mixed", `${taskCommit}~1`]).catch(() => undefined); };
    const upToDate = await git(worktree.path, ["merge-base", "--is-ancestor", staging.branch, "HEAD"]).then(() => true, () => false);
    if (!upToDate) {
      // Parallel tasks landed after this worktree branched; fold them in, then re-verify the combined code.
      try { await git(worktree.path, [...identity, "merge", "--no-edit", staging.branch]); }
      catch (error) {
        const conflicted = (await git(worktree.path, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
        if (!await resolveMergeConflicts(state, task, resolver, worktree.path, conflicted, providerFor(providers, resolver), tools, identity)) {
          await git(worktree.path, ["merge", "--abort"]).catch(() => undefined);
          await uncommit();
          throw new Error(`${task.title} conflicts with work already merged from parallel tasks (${conflicted.join(", ") || "no conflict files reported"}), and ${roster[resolver].name} could not reconcile it. ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      checks = await runChecks(worktree.path, { repo: state.repo, runDir: state.runDir, taskId: `${task.id}-merged` });
      taskState.checks = checks;
      if (failingChecks(checks).length && !acceptFailingChecks) {
        await uncommit();
        throw new Error(`Checks failed after combining ${task.title} with parallel tasks.\n${checksText(checks)}`);
      }
    }
    await git(staging.path, ["merge", "--ff-only", worktree.branch]);
    return !upToDate;
  });
  taskState.status = "done";
  taskState.error = undefined;
  await recordRunEvent(state, task.worker, "integrated", `${staging.branch}${combined ? " (combined with parallel tasks)" : ""}; checks: ${checksLine(checks)}`, { taskId: task.id, summary: `Completed ${task.title}` });
  await saveState(state);
  return `"${task.title}" is merged into the run's staging branch${combined ? " (combined with work from parallel tasks)" : ""}. Checks: ${checksLine(checks)}.`;
}

/** The task's worker (or Kit, for a read-only worker) reconciles a conflicted merge in place; true only if no markers remain and the merge committed. */
async function resolveMergeConflicts(
  state: TeamRunState, task: TeamTask, persona: PersonaId, cwd: string, files: string[],
  worker: ToolCapableProvider, tools: WorkspaceTools, identity: string[],
): Promise<boolean> {
  if (!files.length) return false;
  await recordRunEvent(state, persona, "conflict", files.join(", "), { taskId: task.id, summary: `Reconciling merge conflicts for ${task.title}` });
  try {
    await askWithTools(state, persona, worker,
      `Goal: ${state.goal}\nYour task "${task.title}" is mid-merge with work that parallel tasks already landed, and these files contain git conflict markers: ${files.join(", ")}.\nOpen each file, keep BOTH sides' intent (your task's changes plus the already-merged work), and remove every <<<<<<<, =======, >>>>>>> marker using apply_patch. Do not drop the other tasks' changes. Do not run git commands.`,
      tools, true, task.id);
    for (const file of files) {
      const text = await readFile(path.join(cwd, file), "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "" : undefined);
      if (text === undefined || /^(<{7}|>{7})( |$)/m.test(text)) return false;
    }
    await git(cwd, ["add", "-A"]);
    await git(cwd, [...identity, "commit", "--no-edit"]);
    await recordRunEvent(state, persona, "conflict-resolved", files.join(", "), { taskId: task.id, summary: `Resolved merge conflicts for ${task.title}` });
    return true;
  } catch (error) {
    await logEvent(state, persona, "conflict-unresolved", error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Piper starts the staged preview; with visual review, Wren then checks the interface in a browser.
 * needsHuman is true when Piper is waiting on the human (a command to approve, a secret, a stopped preview).
 */
export async function previewStep(state: TeamRunState, providers: TeamProviders, visual: boolean): Promise<{ text: string; needsHuman: boolean }> {
  // Restart so the preview serves what is staged now, not what was staged when it first started.
  if (livePreview(state.id)) await stopPreview(state.id);
  const info = await obtainPreview(state, providers.piper);
  if (!info) {
    if (["waiting-approval", "waiting-secret", "stopped"].includes(state.preview?.status ?? "")) return { text: `Piper needs Jake before the preview can start: ${state.preview?.issue ?? "unknown reason"}`, needsHuman: true };
    state.status = "doing";
    await saveState(state);
    return { text: `The preview could not start: ${state.preview?.issue ?? "unknown reason"}`, needsHuman: false };
  }
  if (!visual) return { text: `The preview is healthy at ${info.url}.`, needsHuman: false };
  state.preview!.visualReview = undefined;
  state.preview!.browserResults = undefined;
  let pass: boolean;
  try { pass = await visualReview(state, providers, state.preview!); }
  catch (error) { return { text: `The preview is healthy at ${info.url}, but the browser capture for Wren's review could not run: ${error instanceof Error ? error.message : String(error)}`, needsHuman: false }; }
  const verdict = (state.preview?.visualReview as string | undefined) ?? "(no verdict)";
  return { text: `The preview is healthy at ${info.url}. Wren's visual review ${pass ? "passed" : "found issues"}${state.preview?.visualVerified ? "" : " (no screenshot; page structure only)"}:\n${verdict.slice(0, 3_000)}\nBrowser results: ${JSON.stringify(state.preview?.browserResults ?? []).slice(0, 2_000)}`, needsHuman: false };
}

/** Hollis's release-readiness verification of the staged code, run again each time Marlow asks for it. */
export async function releaseStep(state: TeamRunState, providers: TeamProviders): Promise<string> {
  state.release = undefined;
  await runReleaseStage(state, providers);
  if (!state.release) return "Hollis's release check did not run: the staged code is not an iOS app.";
  return formatReleaseSection(state.release);
}

export async function isWebProject(repo: string): Promise<boolean> {
  try { if (await readCookbook(repo)) return true; } catch { return true; }
  try {
    const pkg = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    if (["dev", "start", "serve", "ui", "preview"].some((name) => pkg.scripts?.[name])) return true;
  } catch { /* another project type */ }
  for (const file of ["index.html", "vite.config.ts", "next.config.js", "manage.py"]) {
    try { await readFile(path.join(repo, file)); return true; } catch { /* not found */ }
  }
  try {
    for (const name of await readdir(repo)) if (name.endsWith(".csproj") && /Microsoft\.NET\.Sdk\.Web/.test(await readFile(path.join(repo, name), "utf8"))) return true;
  } catch { /* not a root .NET web project */ }
  for (const file of ["requirements.txt", "pyproject.toml"]) {
    try { if (/\b(flask|django|fastapi|streamlit|uvicorn)\b/i.test(await readFile(path.join(repo, file), "utf8"))) return true; } catch { /* not configured */ }
  }
  return false;
}

async function piperCookbook(state: TeamRunState, provider: ModelProvider, failure?: string): Promise<Cookbook> {
  const previous = await readCookbook(state.repo);
  const prompt = `Goal: ${state.goal}\nRepository: ${state.repo}\n${previous ? `Current cookbook: ${JSON.stringify(previous)}\n` : ""}${failure ? `Preview failed: ${failure.slice(0, 3_000)}\nRedacted command log:\n${state.preview?.log.slice(-3_000) ?? "(none)"}\n` : ""}Inspect the repository and return ONLY a JSON cookbook: {"version":1,"workingDir":".","setup":["..."],"build":[],"start":"...","healthPath":"/","variables":{"APP_PORT":"{port}"},"secrets":{"APP_SECRET":"vault-name"}}. All commands run in the staging worktree. Use {port} in command or variables so the app binds to 127.0.0.1 on the assigned port. Do not edit code. If the failure requires a code change rather than a cookbook change, reply CODE_CHANGE_NEEDED: with the exact diagnosis.`;
  const text = await askWithTools(state, "piper", requireToolProvider(provider), prompt, new WorkspaceTools(state.staging!.path, "researcher"));
  if (/^CODE_CHANGE_NEEDED:/i.test(text)) throw new Error(text.trim());
  const book = extractCookbook(text);
  await saveCookbook(state.repo, book);
  await recordRunEvent(state, "piper", "cookbook", `Saved preview setup: ${book.start}`, { summary: "Updated the environment cookbook" });
  return book;
}

async function obtainPreview(state: TeamRunState, piper: ModelProvider): Promise<PreviewInfo | undefined> {
  if (!await isWebProject(state.staging!.path)) return undefined;
  let book: Cookbook | undefined;
  try { book = await readCookbook(state.repo); if (!book) book = await piperCookbook(state, piper); }
  catch (error) { state.preview = { status: "failed", log: "", issue: `Piper could not prepare the cookbook: ${error instanceof Error ? error.message : String(error)}` }; state.status = "blocked"; await saveState(state); return undefined; }
  let attempts = state.preview?.piperAttempts ?? 0;
  for (;;) {
    try {
      const info = await startPreview(state, book, state.preview?.approvedKeys ?? []);
      state.preview = { ...state.preview, ...info, piperAttempts: attempts };
      await saveState(state);
      await recordRunEvent(state, "piper", "preview-ready", info.url ?? "", { summary: "Started the local preview" });
      return state.preview;
    } catch (error) {
      if (error instanceof PreviewStopped) { state.preview = { ...state.preview, status: "stopped", log: state.preview?.log ?? "", issue: "Preview was stopped." }; state.status = "blocked"; await saveState(state); return undefined; }
      if (error instanceof PreviewPause) {
        state.preview = { ...state.preview, status: error.kind === "approval" ? "waiting-approval" : "waiting-secret", log: state.preview?.log ?? "", issue: error.message,
          port: error.port,
          command: error.kind === "approval" ? error.value : undefined, commandKey: error.kind === "approval" ? error.key : undefined,
          secret: error.kind === "secret" ? error.value : undefined, piperAttempts: attempts };
        state.status = "blocked"; await saveState(state); return undefined;
      }
      attempts++;
      const detail = error instanceof Error ? error.message : String(error);
      state.preview = { ...state.preview, ...(error instanceof PreviewFailure ? error.info : {}), status: "failed", log: error instanceof PreviewFailure ? error.info.log : state.preview?.log ?? "", issue: detail, piperAttempts: attempts };
      await recordRunEvent(state, "piper", "preview-failed", detail, { summary: `Preview setup failed (attempt ${attempts})` });
      if (attempts > 4) {
        const diagnosis = await askWithTools(state, "piper", requireToolProvider(piper),
          `Preview setup failed after four cookbook revisions. Goal: ${state.goal}\nCookbook: ${JSON.stringify(book)}\nFailure: ${detail}\nRedacted command log:\n${state.preview.log.slice(-3_000)}\nExplain the likely application code change needed, with file hints. Do not edit code.`, new WorkspaceTools(state.staging!.path, "researcher"));
        state.preview.issue = diagnosis;
        state.status = "blocked"; await saveState(state); return undefined;
      }
      try { book = await piperCookbook(state, piper, detail); }
      catch (repairError) { state.preview.issue = repairError instanceof Error ? repairError.message : String(repairError); state.status = "blocked"; await saveState(state); return undefined; }
      state.preview.piperAttempts = attempts;
      await saveState(state);
    }
  }
}

function parseScenarios(text: string): BrowserStep[] {
  try {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(cleaned) as { scenarios?: BrowserStep[] };
    return Array.isArray(parsed.scenarios) ? parsed.scenarios.filter((step) => step &&
      (step.action === "navigate" && typeof step.path === "string" && step.path.startsWith("/") ||
       step.action === "expectText" && typeof step.text === "string" && Boolean(step.text) ||
       (step.action === "click" || step.action === "fill") && typeof step.role === "string" && typeof step.name === "string" &&
         (step.action === "click" || typeof step.value === "string"))).slice(0, 8) : [];
  } catch { return []; }
}

async function visualReview(state: TeamRunState, providers: TeamProviders, info: PreviewInfo): Promise<boolean> {
  const capture = await inspectPreview(state, info);
  const images = await screenshotData(info);
  const prompt = `Goal: ${state.goal}\nReview the combined web interface. Accessible page structure:\n${capture.structure}\nBrowser console errors: ${JSON.stringify(capture.errors)}\nReturn a short JSON object with scenarios (up to 8 steps, each action navigate|click|fill|expectText, path or accessible role/name, optional value/text) that verify the goal. Do not claim an interaction passed yet.`;
  let proposed: string;
  let visualVerified = false;
  try {
    proposed = (await generateFor(state, "wren", providers.wren, { systemPrompt: roster.wren.systemPrompt, userPrompt: prompt, images: images ? [{ mimeType: "image/png", data: images }] : undefined })).text;
    visualVerified = Boolean(images);
  } catch {
    proposed = (await generateFor(state, "wren", providers.wren, { systemPrompt: roster.wren.systemPrompt, userPrompt: prompt + "\nImage input was unavailable; use page structure only." })).text;
  }
  const scenarios = parseScenarios(proposed);
  if (scenarios.length) await runBrowserSteps(state, info, scenarios);
  else { info.browserResults ??= []; info.browserResults.push({ step: "Agent scenarios", status: "missing", detail: "Wren did not provide valid browser steps for this run." }); }
  const results = info.browserResults ?? [];
  const verdictPrompt = `Goal: ${state.goal}\nPage structure:\n${capture.structure}\nBrowser results:\n${JSON.stringify(results)}\nGive a verdict beginning PASS: or ISSUES:. If visual evidence is essential and unavailable, begin NEEDS_VISION: instead. Explain visible problems, failed browser steps, and limitations. ${visualVerified ? "You received the screenshot." : "Screenshot review was unavailable; do not claim visual verification."}`;
  let verdict: string;
  try { verdict = (await generateFor(state, "wren", providers.wren, { systemPrompt: roster.wren.systemPrompt, userPrompt: verdictPrompt, images: visualVerified && images ? [{ mimeType: "image/png", data: images }] : undefined })).text; }
  catch { visualVerified = false; verdict = (await generateFor(state, "wren", providers.wren, { systemPrompt: roster.wren.systemPrompt, userPrompt: verdictPrompt + "\nUse text only." })).text; }
  info.visualReview = verdict;
  info.visualVerified = visualVerified;
  state.preview = { ...state.preview, ...info };
  await recordRunEvent(state, "wren", "visual-review", verdict, { summary: `Reviewed the staged interface: ${verdict.slice(0, 90)}` });
  await saveState(state);
  return /^PASS:/i.test(verdict.trim()) && !results.some((item) => item.status === "failed");
}

export function formatReleaseSection(release: ReleaseStageState): string {
  const label = { ready: "ready", "needs-input": "needs your input", blocked: "blocked", skipped: "skipped", failed: "could not run" }[release.status];
  return `**Release readiness (Hollis): ${label}**\n${release.report.trim()}`;
}

/**
 * Marlow's release check: hand the staging worktree of an iOS app to Hollis for release readiness. It only verifies
 * and reports. Editing, archive, export, upload and device installs are not available to him here (enforced in the
 * session, not just the prompt): the run's code has not been reviewed or merged yet, so shipping is a separate
 * conversation with Hollis afterwards. Runs once per call site; releaseStep clears the old report to run it again.
 */
export async function runReleaseStage(state: TeamRunState, providers: TeamProviders): Promise<void> {
  if (state.release || !state.staging) return;
  if (!await isIosApp(state.staging.path)) return;
  const at = () => new Date().toISOString();
  const provider = providers.hollis;
  if (!provider) {
    state.release = { status: "skipped", report: "No model provider is configured for Hollis (set HOLLIS_PROVIDER and HOLLIS_MODEL, or the lead settings).", at: at() };
    await saveState(state);
    return;
  }
  await recordRunEvent(state, "hollis", "release-stage", "Starting release-readiness verification", { summary: "Hollis started release-readiness verification" });
  try {
    const text = await askWithTools(state, "hollis", requireToolProvider(provider),
      `Goal: ${state.goal}\nMarlow, the lead, asked for a release-readiness check of the work staged in this worktree. You may only verify and report: ios_discover_project, ios_check_readiness, ios_run_operation for generate-project, build-simulator and test-simulator, ios_release_audit, and ios_release_preflight (dry run). Editing, the release workspace, archive, export, upload and device installs are unavailable here (dry runs excepted); do not try to work around that, and never ask for secrets. Read ios_playbook (overview, signing-and-export) first, and use ios_recent_runs, ios_mac_maintenance and web_search if something fails.\nBegin your reply with exactly one of: RELEASE_READY: (everything automatable is verified; only user-only steps remain), RELEASE_NEEDS_INPUT: (verified so far, but the user must supply or decide something), or RELEASE_BLOCKED: (a verification failed or the Mac or project is not usable). Then give a concise report: what was verified with its evidence, what failed, was pending or is blocked with the exact fix for each, and the next steps for the user (review and merge, then chat with Hollis to archive, export and upload, plus App Store Connect entries, which only the user can do). Do not claim anything a tool did not verify.`,
      new WorkspaceTools(state.staging.path, "researcher"), true, undefined, "readiness");
    const status = /^RELEASE_READY:/i.test(text.trim()) ? "ready" : /^RELEASE_BLOCKED:/i.test(text.trim()) ? "blocked" : "needs-input";
    state.release = { status, report: text.trim().replace(/^RELEASE_(?:READY|NEEDS_INPUT|BLOCKED):\s*/i, ""), at: at() };
  } catch (error) {
    state.release = { status: "failed", report: `Hollis could not complete release readiness: ${error instanceof Error ? error.message : String(error)}`, at: at() };
  }
  await recordRunEvent(state, "hollis", "release-report", `${state.release.status}: ${state.release.report.slice(0, 600)}`, { summary: `Release readiness: ${state.release.status}` });
  await saveState(state);
}

/**
 * For an iOS release goal, the steps only Jake can take after the run: the team verifies, it never signs or uploads.
 * Fixed text plus the blockers Hollis's readiness check named; never secret values. Undefined for any other run.
 */
export async function shippingNotes(state: TeamRunState): Promise<string | undefined> {
  if (!state.staging || !goalMentionsRelease(state.goal) || !await isIosApp(state.staging.path)) return undefined;
  const lines = [
    "**Shipping notes (steps for you)**",
    "The team only verified the release. Nothing was signed, archived or uploaded. After you review and merge this run:",
    `1. Allow signing: \`npm run ios -- grant signing --repo "${state.repo}"\``,
    `2. Allow upload: \`npm run ios -- grant upload --repo "${state.repo}"\``,
    `3. Chat with Hollis at his desk (or \`npm run team -- ask --run "${state.runDir}" --persona hollis --message "Archive, export and upload the build"\`) and ask him to archive, export and upload. He checks readiness again first and stops at anything only you can do.`,
    "4. In App Store Connect (only you can do these): fill in the app listing, upload the screenshots, answer App Privacy and the age rating, answer export compliance, then select the uploaded build and click Add for Review.",
  ];
  if (!state.release) lines.push(`Hollis's readiness check did not run in this run. Check first with \`npm run ios -- readiness --repo "${state.repo}"\` and \`npm run ios -- audit --repo "${state.repo}"\`.`);
  else if (state.release.status === "ready") lines.push("Hollis's readiness check found no blockers.");
  else {
    const flagged = state.release.report.split("\n").map((line) => line.trim()).filter((line) => /block|fail|missing|pending|requires?|needs?|not (?:set|configured|granted)/i.test(line)).slice(0, 12);
    lines.push(`Blockers from Hollis's readiness check (${formatReleaseSection(state.release).split("\n")[0].replace(/^\*\*Release readiness \(Hollis\): |\*\*$/g, "")}):`, ...(flagged.length ? flagged.map((line) => `- ${line.replace(/^[-*•]\s*/, "")}`) : [state.release.report.trim().slice(0, 1_500)]));
  }
  return redactSecrets(lines.join("\n"));
}

/** Marlow's finish: his summary for review, Tove's memory note, the release report, his calls to double-check and any shipping notes. */
export async function finishRun(state: TeamRunState, providers: TeamProviders, library: string): Promise<TeamRunState> {
  const director = state.director;
  const overrides = director?.overrides ?? [];
  const taskSummary = state.tasks.map((item) => `${item.id}: ${item.status}; worker: ${state.plan?.tasks.find((task) => task.id === item.id)?.worker ?? "unknown"}; checks: ${checksLine(item.checks)}; review: ${item.review ?? "none"}; QA: ${item.qa ?? "none"}`).join("\n") + (state.integrationChecks ? `\nThis run was updated against newer repository code. Task notes above describe the original build. Checks on the combined code: ${JSON.stringify(state.integrationChecks)}` : "");
  const fullDiff = await git(state.staging!.path, ["diff", "--no-ext-diff", `${state.baseCommit}..HEAD`, "--", "."]);
  const diffStat = await git(state.staging!.path, ["diff", "--no-ext-diff", "--stat=160", `${state.baseCommit}..HEAD`, "--", "."]);
  const finalDiff = fullDiff.length <= 24_000 ? fullDiff : `${fullDiff.slice(0, 24_000)}
... diff truncated at 24000 of ${fullDiff.length} characters; the changed-files list covers every file.`;
  state.summary = (await generateFor(state, "marlow", providers.marlow, {
    systemPrompt: `${roster.marlow.systemPrompt}\n${await personaContext(state.repo, "marlow")}`,
    maxOutputTokens: 4096,
    userPrompt: `Summarize the completed goal and what the user should review before merging. Keep it short: one sentence on what was built, then at most 6 bullets covering what to check by hand and any real risks. No preamble, no nested lists. If the diff below was truncated, say so in one line and use the changed-files list for what you could not read. Goal: ${state.goal}\nYour closing note: ${director?.finishNote ?? "(none)"}\nCalls you made that the user should double-check: ${overrides.length ? overrides.join("; ") : "none"}\nPlan: ${JSON.stringify(state.plan)}\nTasks:\n${taskSummary}\nPreview: ${JSON.stringify(state.preview ? { status: state.preview.status, browserResults: state.preview.browserResults, visualReview: state.preview.visualReview, visualVerified: state.preview.visualVerified } : "not run")}\nChanged files:
${diffStat}
Final diff:
${finalDiff}`,
  })).text;
  state.memoryNote = (await generateFor(state, "tove", providers.tove, {
    systemPrompt: `${roster.tove.systemPrompt}\n${await personaContext(state.repo, "tove")}`,
    userPrompt: `Write concise Markdown memory for future runs. Use the QA findings and final diff below as evidence. Record verified repository conventions, decisions, and remaining uncertainty only. Goal: ${state.goal}\nPlan: ${JSON.stringify(state.plan)}\nTasks:\n${taskSummary}\nFinal diff:\n${finalDiff.slice(0, 24_000)}\nHuman decisions: ${JSON.stringify(state.decisions ?? [])}\nExisting library:\n${library}`,
  })).text;
  const sections = [state.summary.trim()];
  if (state.release && state.release.status !== "skipped") sections.push(formatReleaseSection(state.release));
  if (overrides.length) sections.push(`**Marlow's calls to double-check**\n${overrides.map((item) => `- ${item}`).join("\n")}`);
  const shipping = await shippingNotes(state);
  if (shipping) sections.push(shipping);
  state.summary = sections.join("\n\n");
  state.status = "awaiting-review";
  state.needsPreviewReview = false;
  state.question = undefined;
  if (director) director.finished = true;
  await logEvent(state, "host", "awaiting-review", state.staging!.path);
  await saveState(state);
  return state;
}

export async function runTeamGoal(repoPath: string, goal: string, injectedProviders?: TeamProviders): Promise<TeamRunState> {
  if (!goal.trim()) throw new Error("Provide a non-empty goal.");
  const repo = await resolveCleanRepo(repoPath);
  const providers = injectedProviders ?? await defaultProviders(repo);
  const baseCommit = await git(repo, ["rev-parse", "HEAD"]);
  const state = await createRunState(repo, goal, baseCommit);
  const library = await readLibrary(state);
  try {
    const shape = `{"summary":"...","tasks":[{"id":"short-slug","title":"specific task","worker":"${WORKER_IDS.join("|")}","dependsOn":[],"research":false}]}`;
    const planText = await askWithTools(state, "marlow", requireToolProvider(providers.marlow),
      `Goal: ${goal}\nShared library:\n${library || "(empty)"}\nYour team and what each can do:\n${capabilityList()}\nInspect repository files, then return ONLY a JSON object with this shape: ${shape}. This is your opening plan; you direct the run from here and can add, reassign or skip work later as results come in. Give each task to the teammate whose tools can actually do it (for example, iOS release verification is Hollis's, not a coder's). Set "research": true when Juniper should write a brief first. Keep tasks small, with dependencies listed by ID. Tasks run in parallel in separate worktrees whenever their dependencies allow, so split the goal into independent tasks that touch different files and leave dependsOn empty for them. Add a dependency only when a task needs another task's output or would edit the same files. Do not add review or QA as tasks; you request those when work comes back.`,
      new WorkspaceTools(repo, "researcher"));
    try {
      state.plan = parsePlan(planText);
    } catch (error) {
      await logEvent(state, "host", "plan-invalid", `${error instanceof Error ? error.message : String(error)}
${planText}`);
      const corrected = await generateFor(state, "marlow", providers.marlow, {
        systemPrompt: roster.marlow.systemPrompt,
        maxOutputTokens: 8192,
        userPrompt: `Your previous plan was invalid: ${error instanceof Error ? error.message : String(error)} Return ONLY a JSON object with exactly this shape, with no text before or after it, and every task must have a "title" string: ${shape}. Use 1-${MAX_PLAN_TASKS} tasks. Keep the summary to a few sentences and each title under ${MAX_TASK_TITLE} characters so the reply is not cut off. Previous response:
${planText.slice(0, 8_000)}`,
      });
      try {
        state.plan = parsePlan(corrected.text);
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : String(retryError);
        const replyFile = path.join(state.runDir, "plan-reply.txt");
        await writeFile(replyFile, `First reply:\n${planText}\n\nRetry reply:\n${corrected.text}\n`, "utf8");
        await logEvent(state, "host", "plan-invalid", `Retry failed: ${message}
${corrected.text}`);
        const excerpt = corrected.text.length > 1_500 ? `${corrected.text.slice(0, 1_500)}\n... (${corrected.text.length} characters in all)` : corrected.text;
        throw new Error(`${message}\nMarlow's reply:\n${excerpt}\nFull replies saved at: ${replyFile}`);
      }
    }
    state.tasks = state.plan.tasks.map((task) => ({ id: task.id, status: "todo" }));
    const director = initDirector(state);
    director.decisions = 1;
    director.history.push({ at: new Date().toISOString(), action: "plan", args: {}, ok: true, summary: `Marlow planned ${state.plan.tasks.length} task${state.plan.tasks.length === 1 ? "" : "s"}: ${state.plan.tasks.map((task) => `${task.title.slice(0, 80)} (${roster[task.worker].name})`).join("; ")}`, result: "" });
    await saveState(state);
    await recordRunEvent(state, "marlow", "plan", JSON.stringify(state.plan), { summary: director.history[0].summary });

    state.staging = await createBranchWorktree(repo, `codex/team-${state.id}`, baseCommit);
    return await runDirector(state, providers, library);
  } catch (error) {
    state.status = "blocked";
    await logEvent(state, "host", "error", error instanceof Error ? error.message : String(error));
    await saveState(state);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nRun state saved at: ${state.runDir}`);
  }
}

/**
 * A blocked run keeps working from the checkout it started on. When that checkout has moved on (other runs merged),
 * fold the new commits into the staging branch and rebase the run's base, so the run resumes on current code instead
 * of refusing to continue. Conflicts go to the asked-about task's worker when it can edit files, otherwise to Kit.
 */
async function catchUpBlockedRun(state: TeamRunState, repo: string, taskId: string | undefined, providers: TeamProviders): Promise<void> {
  const head = await git(repo, ["rev-parse", "HEAD"]);
  if (head === state.baseCommit) return;
  const staging = state.staging!;
  const task = state.plan!.tasks.find((item) => item.id === taskId) ?? state.plan!.tasks[0];
  const resolver: PersonaId = task && WRITING_WORKERS.includes(task.worker) ? task.worker : "kit";
  if (await git(staging.path, ["status", "--porcelain", "--untracked-files=all"])) throw new Error(`The team's staging worktree has unsaved edits, so this run cannot be brought up to date: ${staging.path}`);
  const identity = ["-c", "user.name=Agent Team", "-c", "user.email=agent-team@localhost.invalid"];
  try { await git(staging.path, [...identity, "merge", "--no-edit", head]); }
  catch (error) {
    const conflicted = (await git(staging.path, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
    const resolved = Boolean(task) && await resolveMergeConflicts(state, task!, resolver, staging.path, conflicted, providerFor(providers, resolver), new WorkspaceTools(staging.path, "lead"), identity);
    if (!resolved) {
      await git(staging.path, ["merge", "--abort"]).catch(() => undefined);
      throw new Error(`Your checkout moved on and this run's work conflicts with it (${conflicted.join(", ") || "no conflict files reported"}). The team could not reconcile it automatically; discard this run and start the goal again from the current code. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await stopPreview(state.id);
  state.preview = undefined;
  await logEvent(state, "host", "caught-up", `Brought the run up to date with ${head} (was based on ${state.baseCommit})`);
  state.baseCommit = head;
  await saveState(state);
}

/** The human's answer goes to Marlow, who decides what happens next; the run picks up where it paused. */
export async function answerTeamRun(runDir: string, answer: string, injectedProviders?: TeamProviders): Promise<TeamRunState> {
  if (!answer.trim()) throw new Error("Provide a non-empty answer or guidance.");
  const state = await loadState(runDir);
  if (state.status !== "blocked" || !state.staging || !state.plan) throw new Error("Run has no resumable blocked task.");
  const question = state.question;
  const blocked = state.tasks.find((task) => task.status === "blocked");
  if (!question && !blocked) throw new Error("Run has no question waiting for an answer.");
  const taskId = question?.taskId ?? blocked?.id;
  const repo = await resolveCleanRepo(state.repo);
  const providers = injectedProviders ?? await defaultProviders(repo);
  await catchUpBlockedRun(state, repo, taskId, providers);
  state.decisions ??= [];
  state.decisions.push({ taskId: taskId ?? "run", answer: answer.trim(), at: new Date().toISOString() });
  await logEvent(state, "user", "answer", `${taskId ?? "run"}: ${answer}`);
  await recordRunEvent(state, "marlow", "received-answer", answer, { taskId, summary: `Marlow received Jake's answer${question ? ` to: ${question.summary.slice(0, 120)}` : ""}` });
  // A run blocked by the older flow parks its task as "blocked"; Marlow picks it up from "review".
  if (blocked) blocked.status = "review";
  for (const task of state.tasks) task.triageNote = undefined;
  const director = initDirector(state);
  if (director.decisions >= director.allowance) director.allowance = director.decisions + maxDecisions();
  director.pendingEvents.push({ at: new Date().toISOString(), kind: "human-answer", taskId, text: `Jake answered${question ? ` your question ("${question.summary.slice(0, 600)}")` : ""}: ${answer.trim()}` });
  state.question = undefined;
  await saveState(state);
  return runDirector(state, providers, await readLibrary(state));
}

/**
 * After the human approves Piper's command or supplies a secret (or after an update needs a fresh look), start the
 * preview again. Mid-run, the result goes back to Marlow; for a finished run, only the preview and Wren's review rerun.
 */
export async function resumeTeamPreview(runDir: string, approvedCommand?: string, injectedProviders?: TeamProviders): Promise<TeamRunState> {
  const state = await loadState(runDir);
  if (!state.staging || !state.plan) throw new Error("Run is not ready for a preview.");
  if (approvedCommand) {
    if (state.preview?.command !== approvedCommand || state.preview.status !== "waiting-approval") throw new Error("This command is not awaiting approval.");
    state.preview.approvedKeys = [...new Set([...(state.preview.approvedKeys ?? []), state.preview.commandKey!])];
  }
  if (/^NEEDS_VISION:/i.test(state.preview?.visualReview ?? "")) { state.preview!.visualReview = undefined; state.preview!.issue = undefined; }
  const providers = injectedProviders ?? await defaultProviders(state.repo);
  const finished = Boolean(state.director?.finished) || state.status === "awaiting-review";
  state.status = "doing";
  await saveState(state);
  if (finished) {
    const result = await previewStep(state, providers, true);
    await recordRunEvent(state, "piper", "preview-review", result.text.slice(0, 2_000), { summary: "Re-ran the preview for review" });
    if (result.needsHuman) { state.status = "blocked"; await saveState(state); return state; }
    state.status = "awaiting-review";
    state.needsPreviewReview = false;
    await saveState(state);
    return state;
  }
  initDirector(state).pendingEvents.push({ at: new Date().toISOString(), kind: "preview-resumed", text: "Jake dealt with Piper's preview request. Call run_preview again if you still want the preview." });
  await saveState(state);
  return runDirector(state, providers, await readLibrary(state));
}

export async function startTeamPreview(runDir: string, injectedProviders?: TeamProviders): Promise<TeamRunState> {
  const state = await loadState(runDir);
  if (!state.staging || !["awaiting-review", "blocked"].includes(state.status)) throw new Error("This run has no staged preview to start.");
  await obtainPreview(state, (injectedProviders ?? await defaultProviders(state.repo)).piper);
  await saveState(state);
  return state;
}

export async function messageTeamPersona(runDir: string, persona: PersonaId, message: string, injectedProvider?: ToolCapableProvider): Promise<string> {
  if (!message.trim()) throw new Error("Provide a non-empty message.");
  const state = await loadState(runDir);
  const library = await readLibrary(state);
  const workspace = state.staging?.path ?? state.repo;
  const history = (await readPersona(state.repo, persona)).chat.slice(-10).map((item) => `${item.role}: ${item.text}`).join("\n");
  await appendChat(state.repo, persona, { at: new Date().toISOString(), role: "user", text: message, runId: state.id });
  const reply = await askWithTools(state, persona, requireToolProvider(injectedProvider ?? await configuredProvider(state.repo, persona)),
    `Recent conversation:\n${history || "(none)"}\nUser message to ${roster[persona].name}: ${message}\nGoal: ${state.goal}\nCurrent plan: ${JSON.stringify(state.plan ?? null)}\nTask wall: ${JSON.stringify(state.tasks.map((task) => ({ id: task.id, status: task.status })))}\nShared library:\n${library || "(empty)"}\nRespond to the user. ${persona === "hollis" ? "You may edit files only inside a release workspace that you open yourself with ios_open_release_workspace; never in the user's own checkout." : "You may inspect files, but this direct message cannot edit code."}`,
    new WorkspaceTools(workspace, "researcher"), false);
  await appendChat(state.repo, persona, { at: new Date().toISOString(), role: "assistant", text: reply, runId: state.id });
  await appendTimeline(state.repo, persona, { at: new Date().toISOString(), event: "conversation", summary: `Discussed: ${message}`, detail: `User: ${message.slice(0, 1_000)}\nAgent: ${reply.slice(0, 900)}`, feature: state.goal, files: [], runId: state.id, source: "chat" });
  return reply;
}

export async function chatTeamPersona(repo: string, persona: PersonaId, message: string): Promise<string> {
  if (!message.trim()) throw new Error("Provide a non-empty message.");
  const profile = await readPersona(repo, persona);
  const library = await readLibrary({ libraryPath: `${repoHome(repo)}/library.md` });
  const history = profile.chat.slice(-10).map((item) => `${item.role}: ${item.text}`).join("\n");
  await appendChat(repo, persona, { at: new Date().toISOString(), role: "user", text: message });
  const provider = requireToolProvider(await configuredProvider(repo, persona));
  const personal = await personaContext(repo, persona);
  const tools = new WorkspaceTools(repo, "researcher");
  const hollis = persona === "hollis" ? createHollisSession({ repo, root: repo, writable: false }) : undefined;
  const response = await trackedGenerateWithTools(repo, persona, await effectiveModel(repo, persona), provider, {
    systemPrompt: `${roster[persona].systemPrompt}\n${personal}`,
    userPrompt: `Recent conversation:\n${history || "(none)"}\nShared repository library:\n${library || "(empty)"}\nUser: ${message}\nReply as ${roster[persona].name}. ${persona === "hollis" ? "You may inspect the repository; open a release workspace (ios_open_release_workspace) before any edit." : "You may inspect the repository, but do not edit files."}`,
    tools: hollis ? [...hollis.definitions, ...memoryTools] : [...tools.definitions, ...memoryTools, ...buildEnvironmentTools(false)],
    execute: (name, args) => name === "search_memory" || name === "get_memory_entry"
      ? executeMemoryTool(repo, persona, name, args)
      : hollis
        ? hollis.execute(name, args).then((result) => result ?? tools.execute(name, args))
      : name === "inspect_build_environment"
        ? executeBuildEnvironmentTool(name, repo, repo, false)
        : tools.execute(name, args),
    ...(hollis ? hollisLimits() : toolLoopLimits()),
  });
  const reply = response.text.trim();
  if (!reply) throw new Error(`${roster[persona].name} returned an empty response.`);
  await appendChat(repo, persona, { at: new Date().toISOString(), role: "assistant", text: reply });
  await appendTimeline(repo, persona, { at: new Date().toISOString(), event: "conversation", summary: `Discussed: ${message}`, detail: `User: ${message.slice(0, 1_000)}\nAgent: ${reply.slice(0, 900)}`, feature: undefined, files: [], source: "chat" });
  return reply;
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
  if (state.integration) throw new Error("Finish updating this run before merging.");
  if (state.needsPreviewReview) throw new Error("Review the updated preview before merging.");
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
