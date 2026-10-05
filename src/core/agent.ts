import type { ModelProvider } from "./provider.js";

export class Agent {
  constructor(
    readonly name: string,
    private readonly systemPrompt: string,
    private readonly provider: ModelProvider,
  ) {}

  async run(input: string): Promise<string> {
    const response = await this.provider.generate({
      systemPrompt: this.systemPrompt,
      userPrompt: input,
    });
    if (!response.text.trim()) {
      throw new Error(`${this.name} received an empty response from ${this.provider.name}`);
    }
    return response.text;
  }
}
