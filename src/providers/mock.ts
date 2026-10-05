import type { ModelRequest, ModelResponse, ToolCapableProvider, ToolRequest, ToolResponse } from "../core/provider.js";

export class MockProvider implements ToolCapableProvider {
  readonly name = "mock";

  async generate(request: ModelRequest): Promise<ModelResponse> {
    return { text: `[mock response]\nSystem: ${request.systemPrompt}\nInput: ${request.userPrompt}` };
  }

  async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
    return { text: `[mock ${request.tools.map((tool) => tool.name).join(", ")}] ${request.userPrompt.slice(0, 300)}`, toolCalls: 0 };
  }
}
