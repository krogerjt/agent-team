import OpenAI from "openai";
import type { ModelRequest, ModelResponse, ToolCapableProvider, ToolRequest, ToolResponse } from "../core/provider.js";
import { ToolBudget } from "../core/tool-loop.js";

export class OpenAIProvider implements ToolCapableProvider {
  readonly name = "openai";

  constructor(private readonly model: string, private readonly client = new OpenAI()) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.responses.create({
      model: this.model,
      instructions: request.systemPrompt,
      input: request.images?.length ? [{ role: "user" as const, content: [
        { type: "input_text" as const, text: request.userPrompt },
        ...request.images.map((item) => ({ type: "input_image" as const, image_url: `data:${item.mimeType};base64,${item.data}`, detail: "high" as const })),
      ] }] : request.userPrompt,
    });
    return { text: response.output_text };
  }

  async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
    const budget = new ToolBudget(request);
    const tools = request.tools.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: true,
    }));
    let response = await this.client.responses.create({
      model: this.model,
      instructions: request.systemPrompt,
      input: request.userPrompt,
      tools,
    });
    while (true) {
      budget.nextRound();
      const calls = response.output.filter((item) => item.type === "function_call");
      if (calls.length === 0) return { text: response.output_text, toolCalls: budget.toolCalls };
      const results = [];
      for (const call of calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.arguments) as Record<string, unknown>;
          if (args === null || Array.isArray(args) || typeof args !== "object") throw new Error("Expected an object.");
        } catch {
          args = {};
        }
        const result = await budget.execute(request, call.name, args);
        results.push({ type: "function_call_output" as const, call_id: call.call_id, output: JSON.stringify(result) });
      }
      response = await this.client.responses.create({
        model: this.model,
        instructions: request.systemPrompt,
        previous_response_id: response.id,
        input: results,
        tools,
      });
    }
  }
}
