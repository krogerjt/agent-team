export interface ModelRequest {
  systemPrompt: string;
  userPrompt: string;
}

export interface ModelResponse {
  text: string;
}

export interface ModelProvider {
  readonly name: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
}
