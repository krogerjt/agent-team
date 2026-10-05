import type { ModelProvider } from "./core/provider.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { BedrockProvider } from "./providers/bedrock.js";
import { MockProvider } from "./providers/mock.js";
import { OpenAIProvider } from "./providers/openai.js";

export type Role = "lead" | "researcher" | "reviewer";
export type ProviderName = "mock" | "openai" | "anthropic" | "bedrock";
type Environment = NodeJS.ProcessEnv;

export function resolveProviderConfig(role: Role, env: Environment = process.env): {
  provider: ProviderName;
  model?: string;
} {
  const prefix = role.toUpperCase();
  const value = (env[`${prefix}_PROVIDER`] || "mock").toLowerCase();
  if (value !== "mock" && value !== "openai" && value !== "anthropic" && value !== "bedrock") {
    throw new Error(`${prefix}_PROVIDER must be mock, openai, anthropic, or bedrock; received "${value}".`);
  }
  if (value === "mock") return { provider: "mock" };

  const model = env[`${prefix}_MODEL`]?.trim() || env[`${value.toUpperCase()}_MODEL`]?.trim();
  if (!model) throw new Error(`Set ${prefix}_MODEL or ${value.toUpperCase()}_MODEL for ${role}.`);
  if (value === "openai" && !env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY for the OpenAI provider.");
  if (value === "anthropic" && !env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY for the Anthropic provider.");
  return { provider: value, model };
}

export function createProvider(role: Role, env: Environment = process.env): ModelProvider {
  const config = resolveProviderConfig(role, env);
  switch (config.provider) {
    case "mock": return new MockProvider();
    case "openai": return new OpenAIProvider(config.model!);
    case "anthropic": return new AnthropicProvider(config.model!);
    case "bedrock": return new BedrockProvider(config.model!);
  }
}
