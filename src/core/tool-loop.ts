import type { ToolCallTrace, ToolLoopDiagnostics, ToolRequest, ToolResult } from "./provider.js";

export const DEFAULT_MAX_TOOL_CALLS = 40;
export const DEFAULT_MAX_ROUNDS = 24;

function printableArgs(args: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(args);
  if (text.length <= 500) return args;
  return { preview: `${text.slice(0, 497)}...` };
}

export class ToolBudget {
  readonly maxRounds: number;
  readonly maxToolCalls: number;
  private remaining: number;
  private rounds = 0;
  private traces: ToolCallTrace[] = [];
  private readonly reportDiagnostics?: (diagnostics: ToolLoopDiagnostics) => void;
  toolCalls = 0;

  constructor(request: ToolRequest) {
    this.remaining = request.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.maxToolCalls = this.remaining;
    this.maxRounds = request.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.reportDiagnostics = request.telemetry?.recordToolLoop;
  }

  nextRound(): void {
    this.rounds += 1;
    if (this.rounds > this.maxRounds) {
      throw this.limitError("model rounds", "The model kept requesting another round without producing a final response.");
    }
  }

  async execute(request: ToolRequest, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.remaining <= 0) {
      throw this.limitError("tool calls", "The tool budget was exhausted before the model produced a final response.");
    }
    this.remaining -= 1;
    this.toolCalls += 1;
    const trace: ToolCallTrace = { round: this.rounds, name, args: printableArgs(args) };
    const started = performance.now();
    this.traces.push(trace);
    if (!request.tools.some((tool) => tool.name === name)) {
      trace.durationMs = Math.round(performance.now() - started);
      trace.isError = true;
      return { content: `Unknown or unavailable tool: ${name}`, isError: true };
    }
    try {
      const result = await request.execute(name, args);
      trace.durationMs = Math.round(performance.now() - started);
      trace.isError = Boolean(result.isError);
      return { content: result.content.slice(0, 24_000), isError: result.isError };
    } catch (error) {
      trace.durationMs = Math.round(performance.now() - started);
      trace.isError = true;
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  diagnostics(bottleneck?: string): ToolLoopDiagnostics {
    return {
      rounds: Math.min(this.rounds, this.maxRounds), toolCalls: this.toolCalls,
      maxRounds: this.maxRounds, maxToolCalls: this.maxToolCalls,
      calls: this.traces.slice(), bottleneck,
    };
  }

  private limitError(limit: string, bottleneck: string): Error {
    const diagnostics = this.diagnostics(bottleneck);
    const recent = diagnostics.calls.slice(-8).map((call) =>
      `#${call.round} ${call.name}${call.isError ? " [error]" : ""}`).join(", ") || "none";
    const error = new Error(
      `Agent exceeded ${limit}. Diagnostics: ${diagnostics.rounds}/${diagnostics.maxRounds} rounds, ` +
      `${diagnostics.toolCalls}/${diagnostics.maxToolCalls} tool calls. Recent tools: ${recent}. ` +
      `Bottleneck: ${bottleneck}`,
    );
    this.reportDiagnostics?.(diagnostics);
    (error as Error & { diagnostics?: ToolLoopDiagnostics }).diagnostics = diagnostics;
    return error;
  }
}
