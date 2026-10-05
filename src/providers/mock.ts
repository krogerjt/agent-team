import type { ModelProvider, ModelRequest, ModelResponse } from "../core/provider.js";

export class MockProvider implements ModelProvider {
  readonly name = "mock";

  async generate(request: ModelRequest): Promise<ModelResponse> {
    return { text: `[mock response]\nSystem: ${request.systemPrompt}\nInput: ${request.userPrompt}` };
  }
}
