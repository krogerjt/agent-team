import "dotenv/config";
import { Agent } from "./core/agent.js";
import { Orchestrator } from "./core/orchestrator.js";
import { createProvider } from "./config.js";
import { leadPrompt } from "./personas/lead.js";
import { researcherPrompt } from "./personas/researcher.js";
import { reviewerPrompt } from "./personas/reviewer.js";

const goal = process.argv.slice(2).join(" ").trim() ||
  "Design an approach for adding rate limiting to an ASP.NET API.";

async function main(): Promise<void> {
  const orchestrator = new Orchestrator(
    new Agent("Researcher", researcherPrompt, createProvider("researcher")),
    new Agent("Reviewer", reviewerPrompt, createProvider("reviewer")),
    new Agent("Lead", leadPrompt, createProvider("lead")),
  );
  const result = await orchestrator.run(goal);
  console.log(`GOAL:\n${result.goal}\n`);
  console.log(`RESEARCH:\n${result.research}\n`);
  console.log(`REVIEW:\n${result.review}\n`);
  console.log(`FINAL ANSWER:\n${result.answer}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
