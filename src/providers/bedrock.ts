import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { ModelProvider, ModelRequest, ModelResponse } from "../core/provider.js";

export class BedrockProvider implements ModelProvider {
  readonly name = "bedrock";
  private readonly client = new BedrockRuntimeClient({});

  constructor(private readonly model: string) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.send(new ConverseCommand({
      modelId: this.model,
      system: [{ text: request.systemPrompt }],
      messages: [{ role: "user", content: [{ text: request.userPrompt }] }],
      inferenceConfig: { maxTokens: 2048 },
    }));
    return {
      text: response.output?.message?.content
        ?.map((block) => block.text ?? "")
        .filter(Boolean)
        .join("\n") ?? "",
    };
  }
}
