import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolBudget } from "./tool-loop.js";
import type { ToolRequest } from "./provider.js";

function request(overrides: Partial<ToolRequest> = {}): ToolRequest {
  return {
    systemPrompt: "system", userPrompt: "user", tools: [{ name: "read_file", description: "read", parameters: {} }],
    execute: async () => ({ content: "ok" }), ...overrides,
  };
}

test("tool budget reports the tools tried when tool calls are exhausted", async () => {
  const budget = new ToolBudget(request({ maxToolCalls: 2, maxRounds: 4 }));
  budget.nextRound();
  await budget.execute(request({ maxToolCalls: 2, maxRounds: 4 }), "read_file", { path: "one.txt" });
  await budget.execute(request({ maxToolCalls: 2, maxRounds: 4 }), "read_file", { path: "two.txt" });

  await assert.rejects(() => budget.execute(request({ maxToolCalls: 2, maxRounds: 4 }), "read_file", { path: "three.txt" }), (error: unknown) => {
    assert.match((error as Error).message, /Agent exceeded tool calls/);
    assert.match((error as Error).message, /read_file.*read_file/);
    assert.match((error as Error).message, /tool budget was exhausted/);
    assert.equal((error as Error & { diagnostics: { toolCalls: number } }).diagnostics.toolCalls, 2);
    return true;
  });
});

test("tool budget reports model-round bottlenecks", () => {
  const budget = new ToolBudget(request({ maxRounds: 1 }));
  budget.nextRound();
  assert.throws(() => budget.nextRound(), (error: unknown) => {
    assert.match((error as Error).message, /Agent exceeded model rounds/);
    assert.match((error as Error).message, /without producing a final response/);
    return true;
  });
});

test("tool budget stops repeated identical tool failures with recovery guidance", async () => {
  const failing = request({ maxToolCalls: 10, maxRounds: 10, execute: async () => ({ content: "oldText must match exactly once.", isError: true }) });
  const budget = new ToolBudget(failing);
  budget.nextRound();
  await budget.execute(failing, "read_file", { path: "file.swift" });
  await budget.execute(failing, "read_file", { path: "file.swift" });
  await assert.rejects(() => budget.execute(failing, "read_file", { path: "file.swift" }), (error: unknown) => {
    assert.match((error as Error).message, /stopped after 3 repeated read_file failures/);
    assert.match((error as Error).message, /oldText must match exactly once/);
    assert.match((error as Error).message, /inspect the current file\/context/);
    return true;
  });
});
