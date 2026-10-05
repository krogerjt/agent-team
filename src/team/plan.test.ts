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

test("rejects invalid workers and cycles", () => {
  assert.throws(() => parsePlan(JSON.stringify({ summary: "x", tasks: [
    { id: "task", title: "Task", worker: "juniper", dependsOn: [] },
  ] })), /unknown worker/);
  assert.throws(() => parsePlan(JSON.stringify({ summary: "x", tasks: [
    { id: "one", title: "One", worker: "kit", dependsOn: ["two"] },
    { id: "two", title: "Two", worker: "wren", dependsOn: ["one"] },
  ] })), /cycle/);
});
