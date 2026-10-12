import assert from "node:assert/strict";
import { test } from "node:test";
import { orderedTasks, parsePlan } from "./plan.js";

test("validates and orders dependent worker tasks", () => {
  const plan = parsePlan(JSON.stringify({ summary: "Build a flow", tasks: [
    { id: "interface", title: "Build interface", worker: "wren", dependsOn: ["api"] },
    { id: "api", title: "Build API", worker: "kit", dependsOn: [] },
  ] }));
  assert.deepEqual(orderedTasks(plan).map((task) => task.id), ["api", "interface"]);
});

test("extracts the plan from fenced or prose-wrapped replies with braces inside strings", () => {
  const body = JSON.stringify({ summary: "Audit {release} settings", tasks: [
    { id: "audit", title: "Check `cachedCards[id]!` and {braces} in strings", worker: "kit", dependsOn: [] },
  ] });
  for (const reply of [`\`\`\`json\n${body}\n\`\`\``, `Here is the plan:\n\n\`\`\`json\n${body}\n\`\`\`\n\nLet me know if you want changes.`, `Plan {draft}: ${body} done.`]) {
    assert.equal(parsePlan(reply).tasks[0].id, "audit");
  }
});

test("accepts the long detailed task titles a long goal produces", () => {
  const title = `Remove the force unwraps in GameViewModel.graveyard and ImportDeckViewModel, ${"then run XcodeGen, the Simulator build and the full test suite reporting pass/fail for each, ".repeat(3)}`;
  assert.ok(title.length > 200);
  assert.equal(parsePlan(JSON.stringify({ summary: "x", tasks: [{ id: "core-data-safety", title, worker: "kit", dependsOn: [] }] })).tasks[0].title, title.trim());
});

test("says when a reply was cut off mid-object", () => {
  const truncated = JSON.stringify({ summary: "A very long summary", tasks: [{ id: "a", title: "A", worker: "kit", dependsOn: [] }] }).slice(0, 60);
  assert.throws(() => parsePlan(truncated), /valid JSON plan.*cut off/);
  assert.throws(() => parsePlan("No plan here."), /no JSON object/);
});

test("rejects invalid workers and cycles", () => {
  assert.throws(() => parsePlan(JSON.stringify({ summary: "x", tasks: [
    { id: "task", title: "Task", worker: "juniper", dependsOn: [] },
  ] })), /unknown worker/);
  assert.throws(() => parsePlan(JSON.stringify({ summary: "x", tasks: [
    { id: "one", title: "One", worker: "kit", dependsOn: ["two"] },
    { id: "two", title: "Two", worker: "wren", dependsOn: ["one"] },
  ] })), /cycle/);
});
