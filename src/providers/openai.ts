import OpenAI from "openai";
import type { ModelProvider, ModelRequest, ModelResponse } from "../core/provider.js";

export class OpenAIProvider implements ModelProvider {
  readonly name = "openai";
  private readonly client = new OpenAI();

  constructor(private readonly model: string) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.responses.create({
      model: this.model,
      instructions: request.systemPrompt,
      input: request.userPrompt,
    });
    return { text: response.output_text };
  }
}
