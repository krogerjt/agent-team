import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { ModelRequest, ModelResponse, ToolCapableProvider, ToolRequest, ToolResponse } from "../core/provider.js";
import { ToolBudget } from "../core/tool-loop.js";

export class BedrockProvider implements ToolCapableProvider {
  readonly name = "bedrock";

  constructor(private readonly model: string, private readonly client = new BedrockRuntimeClient({})) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.send(new ConverseCommand({
      modelId: this.model,
      system: [{ text: request.systemPrompt }],
      messages: [{ role: "user", content: [
        { text: request.userPrompt },
        ...(request.images ?? []).map((item) => ({ image: { format: item.mimeType.split("/")[1] as "png" | "jpeg" | "webp", source: { bytes: Buffer.from(item.data, "base64") } } })),
      ] }],
      inferenceConfig: { maxTokens: 2048 },
    }));
    return {
      text: response.output?.message?.content
        ?.map((block) => block.text ?? "")
        .filter(Boolean)
        .join("\n") ?? "",
    };
  }

  async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
    const budget = new ToolBudget(request);
    const messages: NonNullable<ConstructorParameters<typeof ConverseCommand>[0]["messages"]> = [
      { role: "user", content: [{ text: request.userPrompt }] },
    ];
    const toolConfig = { tools: request.tools.map((tool) => ({
      toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.parameters as never } },
    })) };
    while (true) {
      budget.nextRound();
      const response = await this.client.send(new ConverseCommand({
        modelId: this.model,
        system: [{ text: request.systemPrompt }],
        messages,
        toolConfig,
        inferenceConfig: { maxTokens: 4096 },
      }));
      const message = response.output?.message;
      if (!message) throw new Error("Bedrock returned no message.");
      const calls = message.content?.filter((block) => block.toolUse) ?? [];
      if (calls.length === 0) {
        return { text: message.content?.map((block) => block.text ?? "").filter(Boolean).join("\n") ?? "", toolCalls: budget.toolCalls };
      }
      messages.push(message);
      const results = [];
      for (const call of calls) {
        const use = call.toolUse!;
        const args = use.input && typeof use.input === "object" && !Array.isArray(use.input)
          ? use.input as Record<string, unknown> : {};
        const result = await budget.execute(request, use.name ?? "", args);
        results.push({ toolResult: {
          toolUseId: use.toolUseId,
          content: [{ text: result.content }],
          status: result.isError ? "error" as const : "success" as const,
        } });
      }
      messages.push({ role: "user", content: results });
    }
  }
}
