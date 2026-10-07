import Anthropic from "@anthropic-ai/sdk";
import { reportModelCall, type ModelRequest, type ModelResponse, type ToolCapableProvider, type ToolRequest, type ToolResponse } from "../core/provider.js";
import { ToolBudget } from "../core/tool-loop.js";

export class AnthropicProvider implements ToolCapableProvider {
  readonly name = "anthropic";

  constructor(private readonly model: string, private readonly client = new Anthropic()) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const started = performance.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxOutputTokens ?? 2048,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.images?.length ? [
        ...request.images.map((item) => ({ type: "image" as const, source: { type: "base64" as const, media_type: item.mimeType, data: item.data } })),
        { type: "text" as const, text: request.userPrompt },
      ] : request.userPrompt }],
    });
    reportModelCall(request, started, response.usage ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: response.usage.input_tokens + response.usage.output_tokens } : undefined);
    return {
      text: response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
      usage: response.usage ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: response.usage.input_tokens + response.usage.output_tokens } : undefined,
    };
  }

  async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
    const budget = new ToolBudget(request);
    const tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema,
    }));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: request.userPrompt }];
    while (true) {
      budget.nextRound();
      const started = performance.now();
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: request.systemPrompt,
        messages,
        tools,
      });
      reportModelCall(request, started, response.usage ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: response.usage.input_tokens + response.usage.output_tokens } : undefined);
      const calls = response.content.filter((block) => block.type === "tool_use");
      if (calls.length === 0) {
        return {
          text: response.content.filter((block): block is Anthropic.TextBlock => block.type === "text").map((block) => block.text).join("\n"),
          toolCalls: budget.toolCalls,
          usage: response.usage ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: response.usage.input_tokens + response.usage.output_tokens } : undefined,
        };
      }
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        const args = call.input && typeof call.input === "object" && !Array.isArray(call.input)
          ? call.input as Record<string, unknown> : {};
        const result = await budget.execute(request, call.name, args);
        results.push({ type: "tool_result", tool_use_id: call.id, content: result.content, is_error: result.isError });
      }
      messages.push({ role: "user", content: results });
    }
  }
}
