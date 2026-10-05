import Anthropic from "@anthropic-ai/sdk";
import type { ModelProvider, ModelRequest, ModelResponse } from "../core/provider.js";

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  private readonly client = new Anthropic();

  constructor(private readonly model: string) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userPrompt }],
    });
    return {
      text: response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    };
  }
}
