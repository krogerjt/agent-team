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

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolRequest extends ModelRequest {
  tools: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  maxToolCalls?: number;
  maxRounds?: number;
}

export interface ToolResponse extends ModelResponse {
  toolCalls: number;
}

export interface ToolCapableProvider extends ModelProvider {
  generateWithTools(request: ToolRequest): Promise<ToolResponse>;
}

export function requireToolProvider(provider: ModelProvider): ToolCapableProvider {
  if (!("generateWithTools" in provider) || typeof provider.generateWithTools !== "function") {
    throw new Error(`${provider.name} does not support coding tools.`);
  }
  return provider as ToolCapableProvider;
}
