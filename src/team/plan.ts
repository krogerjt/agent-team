import type { WorkerId } from "../personas/roster.js";

export interface TeamTask {
  id: string;
  title: string;
  worker: WorkerId;
  dependsOn: string[];
}

export interface TeamPlan {
  summary: string;
  tasks: TeamTask[];
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Plan must be a JSON object.");
  return value as Record<string, unknown>;
}

/** Longest task title accepted. The title is also the worker's assignment, so detailed goals produce long ones. */
export const MAX_TASK_TITLE = 1_000;

/**
 * Pull the plan object out of a model reply that may wrap it in a code fence or surround it with prose.
 * Scans for each top-level balanced `{...}` (string-aware) and returns the first that parses; the error says
 * whether the reply was cut off mid-object so the retry prompt can ask for a shorter answer.
 */
export function extractJsonObject(text: string): unknown {
  let firstError: string | undefined;
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0, inString = false, escaped = false, end = -1;
    for (let i = start; i < text.length && end === -1; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "\"") inString = false;
      } else if (ch === "\"") inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) end = i;
    }
    if (end === -1) {
      if (start === text.indexOf("{")) throw new Error("The reply was cut off before the JSON object closed; return a shorter plan.");
      break;
    }
    try { return JSON.parse(text.slice(start, end + 1)) as unknown; }
    catch (error) { firstError ??= error instanceof Error ? error.message : String(error); }
    start = end;
  }
  throw new Error(firstError ? `The JSON in the reply did not parse (${firstError}).` : "The reply contained no JSON object.");
}

export function parsePlan(text: string): TeamPlan {
  let raw: Record<string, unknown>;
  try { raw = object(extractJsonObject(text)); }
  catch (error) { throw new Error(`Marlow did not return a valid JSON plan. ${error instanceof Error ? error.message : String(error)}`); }
  if (typeof raw.summary !== "string" || !raw.summary.trim()) throw new Error("Plan needs a summary.");
  if (!Array.isArray(raw.tasks) || raw.tasks.length < 1 || raw.tasks.length > 4) throw new Error("Plan must contain 1-4 tasks.");
  const tasks: TeamTask[] = raw.tasks.map((entry: unknown) => {
    const task = object(entry);
    if (typeof task.id !== "string" || !/^[a-z][a-z0-9-]{0,30}$/.test(task.id)) throw new Error("Task IDs must be short lowercase slugs.");
    const rawTitle = [task.title, task.name, task.description, task.summary].find((value): value is string => typeof value === "string" && value.trim() !== "");
    if (rawTitle === undefined || rawTitle.length > MAX_TASK_TITLE) throw new Error(`Task ${task.id} needs a title in a "title" field (${MAX_TASK_TITLE} characters or fewer).`);
    if (task.worker !== "kit" && task.worker !== "wren" && task.worker !== "rowan") throw new Error(`Task ${task.id} has an unknown worker.`);
    if (!Array.isArray(task.dependsOn) || !task.dependsOn.every((id: unknown) => typeof id === "string")) throw new Error(`Task ${task.id} has invalid dependencies.`);
    return { id: task.id, title: rawTitle.trim(), worker: task.worker, dependsOn: task.dependsOn };
  });
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error("Task IDs must be unique.");
  for (const task of tasks) {
    if (task.dependsOn.includes(task.id) || task.dependsOn.some((id) => !ids.has(id))) throw new Error(`Task ${task.id} has an invalid dependency.`);
  }
  orderedTasks({ summary: raw.summary, tasks });
  return { summary: raw.summary.trim(), tasks };
}

export function orderedTasks(plan: TeamPlan): TeamTask[] {
  const result: TeamTask[] = [];
  const remaining = new Map(plan.tasks.map((task) => [task.id, task]));
  while (remaining.size) {
    const ready = [...remaining.values()].find((task) => task.dependsOn.every((id) => result.some((done) => done.id === id)));
    if (!ready) throw new Error("Task dependencies contain a cycle.");
    result.push(ready);
    remaining.delete(ready.id);
  }
  return result;
}
