import { Agent } from "./agent.js";

export interface RunResult {
  goal: string;
  research: string;
  review: string;
  answer: string;
}

export class Orchestrator {
  constructor(
    private readonly researcher: Agent,
    private readonly reviewer: Agent,
    private readonly lead: Agent,
  ) {}

  async run(goal: string): Promise<RunResult> {
    if (!goal.trim()) throw new Error("Provide a non-empty goal.");
    const research = await this.researcher.run(goal);
    const review = await this.reviewer.run(
      `Original goal:\n${goal}\n\nResearcher's findings:\n${research}`,
    );
    const answer = await this.lead.run(
      `Original goal:\n${goal}\n\nResearcher's findings:\n${research}\n\nReviewer's critique:\n${review}\n\nProduce the final answer. Resolve valid concerns and be explicit about remaining uncertainty.`,
    );
    return { goal, research, review, answer };
  }
}
