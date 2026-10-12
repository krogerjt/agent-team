import type { ToolDefinition, ToolResult } from "../core/provider.js";
import { WorkspaceTools } from "../coding/workspace-tools.js";
import { capabilityList, isWorkerId, roster, WORKER_IDS, type PersonaId } from "../personas/roster.js";
import { maxDecisions, maxParallelTasks, toolLoopLimits } from "../config.js";
import { goalMentionsRelease, isIosApp } from "../ios/release-trigger.js";
import { MAX_TASK_TITLE, taskSlug, type TeamTask } from "./plan.js";
import { logEvent, saveState, type DirectorEvent, type DirectorState, type HumanQuestion, type TeamRunState } from "./state.js";
import { isPersonaId, personaContext } from "./persona-store.js";
import {
  checksLine, failingChecks, finishRun, generateToolsFor, integrateStep, isWebProject, previewStep,
  providerFor, qaStep, recordRunEvent, releaseStep, researchStep, reviewStep, taskStateOf, workStep, type TeamProviders,
} from "./workflow.js";

/**
 * Marlow directs the run. The host calls him when something happens (a task's work finishing, a verdict, a failure,
 * the human's answer, nothing left running), shows him the facts, and does what he decides through typed actions.
 * The host keeps only two rules of its own: a runaway backstop on the number of decisions, and the safety already in
 * the tools (worktrees, serialized fast-forward integration into staging, nothing pushed or merged into the human's
 * checkout, Hollis verify-only, secret redaction). Calls the human should double-check are recorded, not blocked.
 */

const text = (description: string) => ({ type: "string", description });
const reason = text("One line on why. Shown to Jake in the activity feed.");
function action(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return { name, description, parameters: { type: "object", properties, required, additionalProperties: false } };
}

export const directorTools: ToolDefinition[] = [
  action("assign_task", "Add a task and give it to a teammate. It starts by itself as soon as every task it depends on is integrated (right away if none).", {
    persona: text(`Who does it: ${WORKER_IDS.join(", ")}.`), title: text("The specific assignment; this is what the teammate is told to do."),
    dependsOn: { type: "array", items: { type: "string" }, description: "Task IDs that must be integrated first." },
    research: { type: "boolean", description: "Have Juniper write a brief before the work starts." }, reason,
  }, ["persona", "title"]),
  action("request_research", "Ask a teammate a read-only question: Juniper for the codebase, Piper for the Mac, Xcode or preview environment, Hollis for iOS release readiness. With taskId, the answer becomes that task's brief.", {
    question: text("What you want to know."), persona: text("Who answers (default juniper)."), taskId: text("Optional task the answer is for."), reason,
  }, ["question"]),
  action("request_review", "Have a teammate other than the task's worker review its changes. The verdict starts with APPROVED or CHANGES_NEEDED.", {
    taskId: text("The task to review."), reviewer: text("Who reviews (anyone but the worker, including you: marlow)."), reason,
  }, ["taskId", "reviewer"]),
  action("request_qa", "Have a teammate check the task against its goal and what was actually verified. The verdict starts with PASS or ISSUES.", {
    taskId: text("The task to check."), persona: text("Who checks (default tove)."), reason,
  }, ["taskId"]),
  action("send_back", "Send a task back to its current worker with guidance. They continue in the same worktree and see the last review, QA and checks.", {
    taskId: text("The task."), guidance: text("Concrete direction for the worker."),
  }, ["taskId", "guidance"]),
  action("reassign", "Hand a task, with its worktree, to a different teammate and start them on it.", {
    taskId: text("The task."), persona: text(`The new worker: ${WORKER_IDS.join(", ")}.`), reason,
  }, ["taskId", "persona", "reason"]),
  action("integrate", "Merge a task into the run's staging branch (never Jake's checkout) and mark it done. A task with no file changes is just marked done. You may integrate without review or QA, or over failing checks: say why in reason. Jake sees those calls in the review summary.", {
    taskId: text("The task."), reason,
    acceptFailingChecks: { type: "boolean", description: "Integrate even if checks fail after combining with work other tasks already merged." },
  }, ["taskId"]),
  action("run_preview", "Web projects: Piper starts the staged preview; with visualReview (default true) Wren then reviews the interface in a browser.", {
    visualReview: { type: "boolean", description: "Have Wren review the running interface." }, reason,
  }, []),
  action("run_release_check", "iOS apps: Hollis verifies release readiness on the staged code. Verify only: nothing is signed, archived or uploaded.", { reason }, []),
  action("ask_human", "Pause and ask Jake. Write for a busy non-technical person: no jargon, file names or code terms. Work already running finishes first; you are called again with his answer.", {
    summary: text("Two or three plain sentences: what is going on and why it needs him."),
    options: { type: "array", items: { type: "string" }, description: "Up to four short answers he could send, written as instructions." },
    recommended: text("Which option you would pick and why, in one sentence."), taskId: text("Optional task the question is about."),
  }, ["summary"]),
  action("finish", "End the run. Jake gets your summary to review before merging. Only when nothing is running. List anything you chose to skip.", {
    summary: text("What was done and what Jake should look at."),
    skipped: { type: "array", items: { type: "object", properties: { step: { type: "string" }, reason: { type: "string" } }, required: ["step", "reason"], additionalProperties: false }, description: "Steps you decided not to do (for example review, QA, the preview or the release check), each with a one-line reason." },
  }, ["summary"]),
];
const actionNames = new Set(directorTools.map((tool) => tool.name));

export function initDirector(state: TeamRunState): DirectorState {
  state.director ??= { decisions: 0, allowance: maxDecisions(), history: [], pendingEvents: [], overrides: [] };
  return state.director;
}

interface Job {
  id: number;
  kind: string;
  taskId?: string;
  label: string;
  /** Work and integration own a task; reviews, QA and research can share it. */
  exclusive: boolean;
  run: () => Promise<string>;
}

type Stop = { kind: "finish" } | { kind: "ask"; question: HumanQuestion } | { kind: "preview" };

const name = (persona: string) => isPersonaId(persona) ? roster[persona].name : persona;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export class Director {
  private queue: Job[] = [];
  private running = new Map<number, { job: Job; done: Promise<void> }>();
  private nextJob = 1;
  private stop?: Stop;
  private acted = 0;
  private idleTurns = 0;
  private failedTurns = 0;
  private facts?: { web: boolean; ios: boolean; iosRelease: boolean };

  constructor(private readonly state: TeamRunState, private readonly providers: TeamProviders, private readonly library: string) {
    initDirector(state);
  }

  private get dir(): DirectorState { return this.state.director!; }

  private event(kind: string, text: string, taskId?: string): void {
    this.dir.pendingEvents.push({ at: new Date().toISOString(), kind, taskId, text });
  }

  private jobs(): Job[] { return [...this.queue, ...[...this.running.values()].map((entry) => entry.job)]; }
  private jobsFor(taskId: string): Job[] { return this.jobs().filter((job) => job.taskId === taskId); }

  private enqueue(job: Omit<Job, "id">): void { this.queue.push({ ...job, id: this.nextJob++ }); }

  /** Planned tasks start by themselves once everything they depend on is integrated: that is Marlow's own plan. */
  private startReadyTasks(): void {
    if (this.stop) return;
    const done = (id: string) => this.state.tasks.find((item) => item.id === id)?.status === "done";
    for (const task of this.state.plan?.tasks ?? []) {
      const status = taskStateOf(this.state, task.id).status;
      if (status !== "todo" || this.jobsFor(task.id).length || !task.dependsOn.every(done)) continue;
      this.enqueueWork(task);
    }
  }

  private enqueueWork(task: TeamTask, guidance?: string): void {
    this.enqueue({ kind: "work", taskId: task.id, exclusive: true, label: `${name(task.worker)} working on ${task.id}`,
      run: () => workStep(this.state, this.providers, this.library, task.id, guidance) });
  }

  private pump(): void {
    if (this.stop) return;
    const limit = maxParallelTasks();
    for (let i = 0; i < this.queue.length && this.running.size < limit;) {
      const job = this.queue[i];
      const busy = job.taskId ? [...this.running.values()].map((entry) => entry.job).filter((other) => other.taskId === job.taskId) : [];
      if (busy.some((other) => other.exclusive) || job.exclusive && busy.length) { i++; continue; }
      this.queue.splice(i, 1);
      const done = job.run().then(
        (result) => { this.event(`${job.kind}-done`, result, job.taskId); },
        (error) => { this.event(`${job.kind}-failed`, `${job.label} failed: ${errorText(error)}`, job.taskId); },
      ).then(() => saveState(this.state)).finally(() => { this.running.delete(job.id); this.idleTurns = 0; });
      this.running.set(job.id, { job, done });
    }
  }

  async run(): Promise<TeamRunState> {
    this.state.status = "doing";
    this.state.question = undefined;
    await saveState(this.state);
    for (;;) {
      this.startReadyTasks();
      this.pump();
      if (this.stop) {
        if (!this.running.size) break;
        await Promise.race([...this.running.values()].map((entry) => entry.done));
        continue;
      }
      if (this.dir.pendingEvents.length) { await this.decide(); continue; }
      if (this.running.size) { await Promise.race([...this.running.values()].map((entry) => entry.done)); continue; }
      if (this.queue.length) continue;
      if (this.idleTurns >= 2) {
        this.askHuman({ summary: "Marlow stopped directing the run before finishing it, and nothing is running. Tell him how to continue, or review what is done so far.", options: ["Keep going and finish the goal", "Finish now with what is done"] });
        continue;
      }
      this.idleTurns++;
      this.event("idle", "Nothing is running and nothing is waiting to start. Decide what happens next, or finish.");
    }
    return this.conclude();
  }

  private async conclude(): Promise<TeamRunState> {
    const stop = this.stop!;
    for (const job of this.queue.splice(0)) this.event("not-started", `Not started because the run paused: ${job.label}. Request it again if you still want it.`, job.taskId);
    if (stop.kind === "finish") return finishRun(this.state, this.providers, this.library);
    this.state.status = "blocked";
    if (stop.kind === "ask") {
      this.state.question = stop.question;
      if (stop.question.taskId) taskStateOf(this.state, stop.question.taskId).triageNote = { summary: stop.question.summary, options: stop.question.options, recommended: stop.question.recommended };
      await recordRunEvent(this.state, "marlow", "ask-human", stop.question.summary, { taskId: stop.question.taskId, summary: `Marlow asked Jake: ${stop.question.summary.slice(0, 200)}` });
    }
    await saveState(this.state);
    return this.state;
  }

  private askHuman(question: Omit<HumanQuestion, "at" | "options"> & { options?: string[] }): void {
    this.stop = { kind: "ask", question: { ...question, options: question.options ?? [], at: new Date().toISOString() } };
  }

  private capReached(): void {
    this.askHuman({
      summary: `Marlow has made ${this.dir.decisions} decisions in this run, the most allowed before checking in with you, so the run is paused instead of going round in circles. The task wall shows where things stand.`,
      options: ["Keep going", "Finish now with what is done"],
    });
  }

  private async decide(): Promise<void> {
    const events = this.dir.pendingEvents.splice(0);
    this.acted = 0;
    const workspace = new WorkspaceTools(this.state.staging!.path, "researcher");
    try {
      const response = await generateToolsFor(this.state, "marlow", providerFor(this.providers, "marlow"), {
        systemPrompt: `${roster.marlow.systemPrompt}\n${await personaContext(this.state.repo, "marlow")}`,
        userPrompt: await this.prompt(events),
        tools: [...directorTools, ...workspace.definitions],
        execute: (tool, args) => actionNames.has(tool) ? this.act(tool, args) : workspace.execute(tool, args),
        ...toolLoopLimits(),
      });
      this.failedTurns = 0;
      if (!this.acted && !this.stop) {
        if (this.dir.decisions >= this.dir.allowance) { this.capReached(); return; }
        this.dir.decisions++;
        this.dir.history.push({ at: new Date().toISOString(), action: "none", args: {}, ok: true, summary: `Marlow waited: ${response.text.slice(0, 200) || "(no comment)"}`, result: "" });
        await logEvent(this.state, "marlow", "waiting", response.text.slice(0, 500));
      }
    } catch (error) {
      this.failedTurns++;
      await logEvent(this.state, "marlow", "decision-error", errorText(error));
      if (this.failedTurns >= 2) this.askHuman({ summary: `Marlow could not decide what to do next twice in a row (${errorText(error).slice(0, 300)}). Work already finished is kept.`, options: ["Try again", "Finish now with what is done"] });
      else { this.dir.pendingEvents.unshift(...events); this.event("decision-error", `Your last turn failed before you finished deciding: ${errorText(error).slice(0, 1_000)}. Actions you had already taken still stand.`); }
    }
    await saveState(this.state);
  }

  private async act(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.stop) return { content: "You already chose to finish or to ask Jake. End your turn now.", isError: true };
    if (this.dir.decisions >= this.dir.allowance) {
      this.capReached();
      return { content: `Decision limit reached (${this.dir.allowance}). The run now goes to Jake; end your turn.`, isError: true };
    }
    this.dir.decisions++;
    const at = new Date().toISOString();
    const shown = JSON.parse(JSON.stringify(args, (_key, value) => typeof value === "string" && value.length > 500 ? `${value.slice(0, 500)}…` : value)) as Record<string, unknown>;
    try {
      const { summary, result, taskId } = await this.apply(tool, args);
      this.acted++;
      this.idleTurns = 0;
      this.dir.history.push({ at, action: tool, args: shown, ok: true, summary, result });
      await recordRunEvent(this.state, "marlow", "decision", summary, { taskId, summary });
      await saveState(this.state);
      return { content: result };
    } catch (error) {
      const message = errorText(error);
      this.dir.history.push({ at, action: tool, args: shown, ok: false, summary: `Marlow's ${tool} was turned down: ${message}`, result: message });
      await logEvent(this.state, "marlow", "decision-rejected", `${tool}: ${message}`);
      await saveState(this.state);
      return { content: message, isError: true };
    }
  }

  private async apply(tool: string, args: Record<string, unknown>): Promise<{ summary: string; result: string; taskId?: string }> {
    const state = this.state;
    const str = (key: string, required = true, max = 8_000): string | undefined => {
      const value = args[key];
      if (value === undefined || value === null || value === "") { if (required) throw new Error(`${tool} needs "${key}".`); return undefined; }
      if (typeof value !== "string") throw new Error(`"${key}" must be text.`);
      if (!value.trim() && required) throw new Error(`${tool} needs "${key}".`);
      if (value.length > max) throw new Error(`"${key}" is longer than ${max} characters.`);
      return value.trim();
    };
    const ids = () => state.plan?.tasks.map((item) => item.id) ?? [];
    const task = (): TeamTask => {
      const id = str("taskId")!;
      const found = state.plan?.tasks.find((item) => item.id === id);
      if (!found) throw new Error(`There is no task "${id}". Tasks: ${ids().join(", ") || "none yet"}.`);
      return found;
    };
    const persona = (key: string, fallback: PersonaId | undefined, workersOnly: boolean): PersonaId => {
      const value = (str(key, !fallback) ?? fallback!).toLowerCase();
      if (workersOnly ? !isWorkerId(value) : !isPersonaId(value)) throw new Error(`Unknown persona "${value}". Choose one of: ${(workersOnly ? WORKER_IDS : Object.keys(roster)).join(", ")}.`);
      providerFor(this.providers, value as PersonaId);
      return value as PersonaId;
    };
    const why = str("reason", false, 1_000);
    const because = why ? ` because ${why.replace(/^because\s+/i, "")}` : "";
    const idle = (item: TeamTask) => {
      const busy = this.jobsFor(item.id);
      if (busy.length) throw new Error(`"${item.id}" is busy (${busy.map((job) => job.label).join(", ")}). Wait until you hear back.`);
    };
    const finishedWork = (item: TeamTask) => {
      const status = taskStateOf(state, item.id).status;
      if (status === "done") throw new Error(`"${item.id}" is already integrated.`);
      if (status === "todo") throw new Error(`"${item.id}" has not started yet; it starts by itself once ${item.dependsOn.join(", ") || "its dependencies"} ${item.dependsOn.length === 1 ? "is" : "are"} integrated.`);
      const exclusive = this.jobsFor(item.id).filter((job) => job.exclusive);
      if (exclusive.length) throw new Error(`"${item.id}" is still being worked on (${exclusive.map((job) => job.label).join(", ")}).`);
    };

    switch (tool) {
      case "assign_task": {
        const worker = persona("persona", undefined, true) as TeamTask["worker"];
        const title = str("title", true, MAX_TASK_TITLE)!;
        const dependsOn = args.dependsOn ?? [];
        if (!Array.isArray(dependsOn) || !dependsOn.every((id) => typeof id === "string")) throw new Error(`"dependsOn" must be a list of task IDs.`);
        const unknown = dependsOn.filter((id) => !ids().includes(id));
        if (unknown.length) throw new Error(`Unknown dependencies: ${unknown.join(", ")}. Tasks: ${ids().join(", ") || "none yet"}.`);
        const id = taskSlug(title, ids());
        state.plan!.tasks.push({ id, title, worker, dependsOn: dependsOn as string[], ...(args.research === true ? { research: true } : {}) });
        state.tasks.push({ id, status: "todo" });
        const waiting = (dependsOn as string[]).filter((dep) => taskStateOf(state, dep).status !== "done");
        return { taskId: id, summary: `Marlow gave "${title.slice(0, 160)}" to ${name(worker)}${because}`,
          result: `Added task ${id} for ${name(worker)}. ${waiting.length ? `It starts once ${waiting.join(", ")} ${waiting.length === 1 ? "is" : "are"} integrated.` : "It starts now."}` };
      }
      case "request_research": {
        const question = str("question")!;
        const who = persona("persona", "juniper", false);
        const item = args.taskId ? task() : undefined;
        this.enqueue({ kind: "research", taskId: item?.id, exclusive: false, label: `${name(who)} researching${item ? ` for ${item.id}` : ""}`,
          run: () => researchStep(state, this.providers, this.library, who, question, item?.id) });
        return { taskId: item?.id, summary: `Marlow asked ${name(who)}: ${question.slice(0, 200)}`, result: `${name(who)} is looking into it. You will hear back when the answer is in.` };
      }
      case "request_review": case "request_qa": {
        const item = task();
        const who = tool === "request_review" ? persona("reviewer", undefined, false) : persona("persona", "tove", false);
        if (who === item.worker) throw new Error(`${name(who)} did this task; pick someone else to ${tool === "request_review" ? "review" : "check"} it.`);
        finishedWork(item);
        const taskState = taskStateOf(state, item.id);
        if (tool === "request_review" && !taskState.hasChanges) throw new Error(`"${item.id}" has no file changes to review.`);
        const kind = tool === "request_review" ? "review" : "qa";
        if (this.jobsFor(item.id).some((job) => job.kind === kind)) throw new Error(`A ${kind === "qa" ? "QA check" : "review"} of "${item.id}" is already under way.`);
        this.enqueue({ kind, taskId: item.id, exclusive: false, label: `${name(who)} ${kind === "qa" ? "checking" : "reviewing"} ${item.id}`,
          run: () => kind === "review" ? reviewStep(state, this.providers, this.library, item.id, who) : qaStep(state, this.providers, this.library, item.id, who) });
        return { taskId: item.id, summary: `Marlow asked ${name(who)} to ${kind === "qa" ? "QA" : "review"} "${item.title.slice(0, 160)}"${because}`, result: `${name(who)} is on it.` };
      }
      case "send_back": {
        const item = task();
        const guidance = str("guidance")!;
        idle(item);
        const taskState = taskStateOf(state, item.id);
        if (taskState.status === "done") throw new Error(`"${item.id}" is already integrated. Assign a new task for follow-up work.`);
        if (taskState.status === "todo") throw new Error(`"${item.id}" has not started yet. Use reassign to change who does it.`);
        (taskState.triageLog ??= []).push({ guidance, at: new Date().toISOString() });
        this.enqueueWork(item, guidance);
        return { taskId: item.id, summary: `Marlow sent "${item.title.slice(0, 120)}" back to ${name(item.worker)}: ${guidance.slice(0, 200)}`, result: `${name(item.worker)} is continuing "${item.id}" with your guidance.` };
      }
      case "reassign": {
        const item = task();
        const worker = persona("persona", undefined, true) as TeamTask["worker"];
        if (!why) throw new Error(`reassign needs "reason".`);
        if (worker === item.worker) throw new Error(`${name(worker)} already has "${item.id}".`);
        idle(item);
        const taskState = taskStateOf(state, item.id);
        if (taskState.status === "done") throw new Error(`"${item.id}" is already integrated. Assign a new task for follow-up work.`);
        const previous = item.worker;
        item.worker = worker;
        const handover = `You are taking this task over from ${name(previous)} because ${why}.${taskState.notes ? ` ${name(previous)}'s last report: ${taskState.notes.slice(0, 2_000)}` : ""}`;
        if (taskState.status !== "todo") { (taskState.triageLog ??= []).push({ guidance: `Moved to ${name(worker)}: ${why}`, at: new Date().toISOString() }); this.enqueueWork(item, handover); }
        return { taskId: item.id, summary: `Marlow moved "${item.title.slice(0, 120)}" from ${name(previous)} to ${name(worker)}${because}`,
          result: taskState.status === "todo" ? `${name(worker)} now has "${item.id}"; it starts when its dependencies are integrated.` : `${name(worker)} is taking over "${item.id}" in the same worktree.` };
      }
      case "integrate": {
        const item = task();
        idle(item);
        const taskState = taskStateOf(state, item.id);
        if (taskState.status === "done") throw new Error(`"${item.id}" is already integrated.`);
        if (taskState.status === "todo") throw new Error(`"${item.id}" has not started yet.`);
        const failing = failingChecks(taskState.checks);
        const calls: string[] = [];
        if (taskState.error) calls.push(`${name(item.worker)}'s last attempt failed`);
        if (taskState.hasChanges) {
          if (failing.length) calls.push(`checks failing or missing (${failing.map((check) => check.name).join(", ")})`);
          if (!taskState.review) calls.push("no review");
          else if (!/^APPROVED:/i.test(taskState.review.trim())) calls.push("the review asked for changes");
          if (!taskState.qa) calls.push("no QA");
          else if (!/^PASS:/i.test(taskState.qa.trim())) calls.push("QA found issues");
        }
        const accept = failing.length > 0 || args.acceptFailingChecks === true;
        if (calls.length) this.dir.overrides.push(`"${item.title.slice(0, 160)}" was integrated with ${calls.join(", ")}. Marlow: ${why ?? "no reason given"}`);
        this.enqueue({ kind: "integrate", taskId: item.id, exclusive: true, label: `integrating ${item.id}`,
          run: async () => {
            const result = await integrateStep(state, this.providers, item.id, accept);
            if (accept && !failing.length && failingChecks(taskState.checks).length) this.dir.overrides.push(`"${item.title.slice(0, 160)}" was integrated although checks failed once combined with other tasks' work. Marlow: ${why ?? "no reason given"}`);
            return result;
          } });
        return { taskId: item.id, summary: `Marlow integrated "${item.title.slice(0, 160)}"${calls.length ? ` with ${calls.join(", ")}` : ""}${because}`, result: `Integrating "${item.id}" into staging. You will hear back when it lands.` };
      }
      case "run_preview": {
        const facts = await this.projectFacts();
        if (!facts.web) throw new Error("This is not a web project, so there is no preview to run.");
        if (this.jobs().some((job) => job.kind === "preview")) throw new Error("The preview is already starting.");
        const visual = args.visualReview !== false;
        this.enqueue({ kind: "preview", exclusive: false, label: "Piper starting the preview", run: async () => {
          const result = await previewStep(state, this.providers, visual);
          if (result.needsHuman) this.stop = { kind: "preview" };
          return result.text;
        } });
        return { summary: `Marlow asked Piper for the preview${visual ? " and Wren for a visual review" : ""}${because}`, result: "Piper is starting the preview." };
      }
      case "run_release_check": {
        const facts = await this.projectFacts();
        if (!facts.ios) throw new Error("This repository is not an iOS app, so there is no release check to run.");
        if (this.jobs().some((job) => job.kind === "release")) throw new Error("The release check is already running.");
        this.enqueue({ kind: "release", exclusive: false, label: "Hollis checking release readiness", run: () => releaseStep(state, this.providers) });
        return { summary: `Marlow asked Hollis for a release-readiness check${because}`, result: "Hollis is verifying release readiness (verify only)." };
      }
      case "ask_human": {
        const summary = str("summary", true, 1_200)!;
        const options = Array.isArray(args.options) ? args.options.filter((option): option is string => typeof option === "string" && Boolean(option.trim())).map((option) => option.trim().slice(0, 300)).slice(0, 4) : [];
        const item = args.taskId ? task() : undefined;
        this.askHuman({ summary, options, recommended: str("recommended", false, 500), taskId: item?.id });
        return { taskId: item?.id, summary: `Marlow asked Jake: ${summary.slice(0, 200)}`, result: "Jake will be asked once running work finishes. End your turn." };
      }
      case "finish": {
        const summary = str("summary", true, 4_000)!;
        const busy = this.jobs();
        if (busy.length) throw new Error(`Still running or waiting to start: ${busy.map((job) => job.label).join(", ")}. You will be called when they finish.`);
        const skipped = Array.isArray(args.skipped) ? args.skipped.filter((item): item is { step: string; reason: string } => Boolean(item) && typeof item === "object" && typeof (item as { step?: unknown }).step === "string") : [];
        for (const item of skipped) this.dir.overrides.push(`Skipped ${item.step}: ${typeof item.reason === "string" && item.reason.trim() ? item.reason.trim() : "no reason given"}`);
        for (const item of state.plan?.tasks ?? []) {
          const status = taskStateOf(state, item.id).status;
          if (status !== "done") this.dir.overrides.push(`"${item.title.slice(0, 160)}" (${name(item.worker)}) was not integrated; it was left ${status}.`);
        }
        const facts = await this.projectFacts();
        const listed = (pattern: RegExp) => skipped.some((item) => pattern.test(item.step));
        if (facts.web && !state.preview?.visualReview && !listed(/preview|visual/i)) this.dir.overrides.push("The preview and Wren's visual review did not run.");
        if (facts.iosRelease && !state.release && !listed(/release/i)) this.dir.overrides.push("Hollis's release-readiness check did not run.");
        this.dir.finishNote = summary;
        this.stop = { kind: "finish" };
        return { summary: `Marlow finished the run: ${summary.slice(0, 200)}`, result: "Finishing. End your turn." };
      }
      default:
        throw new Error(`Unknown action ${tool}.`);
    }
  }

  private async projectFacts(): Promise<{ web: boolean; ios: boolean; iosRelease: boolean }> {
    if (!this.facts) {
      const root = this.state.staging!.path;
      const ios = await isIosApp(root);
      this.facts = { web: await isWebProject(root), ios, iosRelease: ios && goalMentionsRelease(this.state.goal) };
    }
    return this.facts;
  }

  private async prompt(events: DirectorEvent[]): Promise<string> {
    const state = this.state;
    const facts = await this.projectFacts();
    const running = [...this.running.values()].map((entry) => entry.job.label);
    const tasks = (state.plan?.tasks ?? []).map((item) => {
      const taskState = taskStateOf(state, item.id);
      const failures = Object.entries(taskState.failures ?? {}).filter(([, count]) => count).map(([persona, count]) => `${name(persona)} ${count}`);
      const jobs = this.jobsFor(item.id).map((job) => job.label);
      return [
        `- ${item.id} [${taskState.status}] "${item.title.slice(0, 400)}" | worker: ${name(item.worker)}`,
        item.dependsOn.length ? `depends on: ${item.dependsOn.join(", ")}` : "",
        taskState.hasChanges === undefined ? "" : taskState.hasChanges ? "has changes" : "no file changes",
        taskState.checks ? `checks: ${checksLine(taskState.checks)}` : "",
        taskState.review ? `review (${taskState.reviewer ?? "?"}): ${taskState.review.trim().split("\n")[0].slice(0, 200)}` : "",
        taskState.qa ? `QA: ${taskState.qa.trim().split("\n")[0].slice(0, 200)}` : "",
        failures.length ? `failures so far: ${failures.join(", ")}` : "",
        taskState.error ? `last error: ${taskState.error.slice(0, 300)}` : "",
        jobs.length ? `in progress: ${jobs.join(", ")}` : "",
      ].filter(Boolean).join(" | ");
    });
    const happened = events.map((item) => `[${item.kind}${item.taskId ? ` task=${item.taskId}` : ""}] ${item.text.slice(0, 8_000)}`).join("\n\n").slice(-60_000);
    return [
      `You are directing this run. Goal: ${state.goal}`,
      `Your team and what each can do:\n${capabilityList()}`,
      `Plan: ${state.plan?.summary ?? "(none)"}`,
      `Tasks:\n${tasks.join("\n") || "(none)"}`,
      `Running now: ${running.join("; ") || "nothing"}. Waiting to start: ${this.queue.map((job) => job.label).join("; ") || "nothing"}.`,
      `Project: web preview available: ${facts.web ? "yes" : "no"}; iOS app: ${facts.ios ? "yes" : "no"}; the goal reads as an iOS release: ${facts.iosRelease ? "yes" : "no"}.`,
      state.preview ? `Preview: ${state.preview.status}${state.preview.visualReview ? `; Wren's verdict: ${state.preview.visualReview.trim().split("\n")[0].slice(0, 200)}` : ""}${state.preview.issue ? `; issue: ${state.preview.issue.slice(0, 300)}` : ""}` : "",
      state.release ? `Release check: ${state.release.status}` : "",
      `Decisions used: ${this.dir.decisions} of ${this.dir.allowance}.`,
      this.dir.history.length ? `Your recent decisions:\n${this.dir.history.slice(-10).map((item) => `- ${item.summary}`).join("\n")}` : "",
      state.decisions?.length ? `Jake's answers so far:\n${state.decisions.slice(-5).map((item) => `- ${item.answer.slice(0, 500)}`).join("\n")}` : "",
      `Shared library:\n${this.library.slice(-8_000) || "(empty)"}`,
      `What happened since your last decision:\n${happened || "(nothing new)"}`,
      [
        "Decide what happens next with the action tools; you can take several actions in one turn, then end your turn. You are called again when something finishes.",
        "Planned tasks start by themselves once their dependencies are integrated. Research, review, QA, repairs, the preview and the release check happen only if you ask for them.",
        "Integration merges into this run's staging branch only; Jake reviews and merges, and nothing is pushed. Inside a run Hollis only verifies: archive, export and upload happen later when Jake chats with him.",
        "If a teammate keeps failing a task, look at whether their tools can do it at all before sending it back again; reassign when someone else can.",
        "Integrating without review or QA, or over failing checks, is your call: give the reason, and it is listed for Jake.",
        "Ask Jake only for what he alone can decide or provide (credentials, a product preference nothing implies, machine setup).",
        "You may read files with the read-only tools before deciding.",
      ].join("\n"),
    ].filter(Boolean).join("\n\n");
  }
}

/** Run (or resume) Marlow's decision loop until he finishes, asks the human, or Piper needs the human for the preview. */
export async function runDirector(state: TeamRunState, providers: TeamProviders, library: string): Promise<TeamRunState> {
  return new Director(state, providers, library).run();
}
