import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "./agent.js";
import { Orchestrator } from "./orchestrator.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "./provider.js";

function provider(name: string, calls: ModelRequest[]): ModelProvider {
  return {
    name,
    async generate(request: ModelRequest): Promise<ModelResponse> {
      calls.push(request);
      return { text: `${name} output` };
    },
  };
}

test("passes research to review and both to lead in order", async () => {
  const researchCalls: ModelRequest[] = [];
  const reviewCalls: ModelRequest[] = [];
  const leadCalls: ModelRequest[] = [];
  const runner = new Orchestrator(
    new Agent("Researcher", "research system", provider("research", researchCalls)),
    new Agent("Reviewer", "review system", provider("review", reviewCalls)),
    new Agent("Lead", "lead system", provider("lead", leadCalls)),
  );

  const result = await runner.run("Build a feature");
  assert.equal(result.research, "research output");
  assert.equal(result.review, "review output");
  assert.equal(result.answer, "lead output");
  assert.equal(researchCalls[0]?.userPrompt, "Build a feature");
  assert.match(reviewCalls[0]?.userPrompt ?? "", /research output/);
  assert.match(leadCalls[0]?.userPrompt ?? "", /research output/);
  assert.match(leadCalls[0]?.userPrompt ?? "", /review output/);
});
