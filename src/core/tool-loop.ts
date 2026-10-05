import type { ToolRequest, ToolResult } from "./provider.js";

export class ToolBudget {
  readonly maxRounds: number;
  private remaining: number;
  private rounds = 0;
  toolCalls = 0;

  constructor(request: ToolRequest) {
    this.remaining = request.maxToolCalls ?? 20;
    this.maxRounds = request.maxRounds ?? 12;
  }

  nextRound(): void {
    this.rounds += 1;
    if (this.rounds > this.maxRounds) throw new Error(`Agent exceeded ${this.maxRounds} model rounds.`);
  }

  async execute(request: ToolRequest, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.remaining <= 0) throw new Error("Agent exceeded its tool-call limit.");
    this.remaining -= 1;
    this.toolCalls += 1;
    if (!request.tools.some((tool) => tool.name === name)) {
      return { content: `Unknown or unavailable tool: ${name}`, isError: true };
    }
    try {
      const result = await request.execute(name, args);
      return { content: result.content.slice(0, 24_000), isError: result.isError };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }
}
