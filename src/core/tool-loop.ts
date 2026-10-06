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
  private lastFailure?: { signature: string; count: number };
  private patchFailures = 0;
  private patchNeedsFreshRead = false;
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
    if (name === "apply_patch" && this.patchNeedsFreshRead) {
      throw this.patchSyncError();
    }
    if (!request.tools.some((tool) => tool.name === name)) {
      trace.durationMs = Math.round(performance.now() - started);
      trace.isError = true;
      return this.failureResult(trace, `Unknown or unavailable tool: ${name}`);
    }
    let result: ToolResult;
    try {
      result = await request.execute(name, args);
    } catch (error) {
      trace.durationMs = Math.round(performance.now() - started);
      trace.isError = true;
      return this.failureResult(trace, error instanceof Error ? error.message : String(error));
    }
    trace.durationMs = Math.round(performance.now() - started);
    trace.isError = Boolean(result.isError);
    const content = result.content.slice(0, 24_000);
    if (result.isError) {
      if (name === "apply_patch") {
        this.patchFailures += 1;
        this.patchNeedsFreshRead = true;
        if (this.patchFailures >= 2) throw this.patchSyncError(content);
      }
      return this.failureResult(trace, content);
    }
    if (name === "read_file") this.patchNeedsFreshRead = false;
    if (name === "apply_patch") this.patchFailures = 0;
    this.lastFailure = undefined;
    return { content, isError: result.isError };
  }

  diagnostics(bottleneck?: string): ToolLoopDiagnostics {
    return {
      rounds: Math.min(this.rounds, this.maxRounds), toolCalls: this.toolCalls,
      maxRounds: this.maxRounds, maxToolCalls: this.maxToolCalls,
      calls: this.traces.slice(), bottleneck,
    };
  }

  private failureResult(trace: ToolCallTrace, content: string): ToolResult {
    const error = content.slice(0, 1_000);
    trace.error = error;
    const signature = `${trace.name}:${error}`;
    const count = this.lastFailure?.signature === signature ? this.lastFailure.count + 1 : 1;
    this.lastFailure = { signature, count };
    if (count >= 3) {
      const diagnostics = this.diagnostics(`Repeated failure from ${trace.name} (${count} identical attempts): ${error}`);
      const failure = new Error(
        `Agent stopped after ${count} repeated ${trace.name} failures. ` +
        `Bottleneck: ${error} ` +
        `Recovery: inspect the current file/context before retrying this operation.`,
      );
      this.reportDiagnostics?.(diagnostics);
      (failure as Error & { diagnostics?: ToolLoopDiagnostics }).diagnostics = diagnostics;
      throw failure;
    }
    return { content, isError: true };
  }

  private patchSyncError(detail = "The patch context did not match the current file."): Error {
    const diagnostics = this.diagnostics(
      `apply_patch failed and requires a fresh read_file before retrying. ${detail}`,
    );
    const error = new Error(
      `apply_patch needs fresh file context before retrying. ${detail} ` +
      `Recovery: call read_file for the target file and rebuild oldText from its current contents. ` +
      `Do not reuse the previous patch.`,
    );
    this.reportDiagnostics?.(diagnostics);
    (error as Error & { diagnostics?: ToolLoopDiagnostics }).diagnostics = diagnostics;
    return error;
  }

  private limitError(limit: string, bottleneck: string): Error {
    const diagnostics = this.diagnostics(bottleneck);
    const recent = diagnostics.calls.slice(-8).map((call) =>
      `#${call.round} ${call.name}${call.isError ? ` [error: ${call.error ?? "unknown"}]` : ""}`).join(", ") || "none";
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
