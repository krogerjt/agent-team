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

export function parsePlan(text: string): TeamPlan {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let raw: Record<string, unknown>;
  try { raw = object(JSON.parse(cleaned) as unknown); }
  catch { throw new Error("Marlow did not return a valid JSON plan."); }
  if (typeof raw.summary !== "string" || !raw.summary.trim()) throw new Error("Plan needs a summary.");
  if (!Array.isArray(raw.tasks) || raw.tasks.length < 1 || raw.tasks.length > 4) throw new Error("Plan must contain 1-4 tasks.");
  const tasks: TeamTask[] = raw.tasks.map((entry: unknown) => {
    const task = object(entry);
    if (typeof task.id !== "string" || !/^[a-z][a-z0-9-]{0,30}$/.test(task.id)) throw new Error("Task IDs must be short lowercase slugs.");
    const rawTitle = [task.title, task.name, task.description, task.summary].find((value): value is string => typeof value === "string" && value.trim() !== "");
    if (rawTitle === undefined || rawTitle.length > 200) throw new Error(`Task ${task.id} needs a short title in a "title" field (200 characters or fewer).`);
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
