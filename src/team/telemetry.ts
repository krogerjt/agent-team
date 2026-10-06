import type { ModelProvider, ModelRequest, ModelResponse, ToolCapableProvider, ToolRequest, ToolResponse } from "../core/provider.js";
import { recordPersonaUsage, type PersonaUsageSample } from "./persona-store.js";
import type { PersonaId } from "../personas/roster.js";
import type { ProviderName } from "../config.js";

type Identity = { provider: ProviderName; model?: string };

function trackedRequest<T extends ModelRequest>(request: T, calls: PersonaUsageSample["calls"]): T {
  return { ...request, telemetry: { recordCall: (usage, durationMs) => calls.push({ usage, durationMs }) } };
}

async function persist(repo: string, persona: PersonaId, identity: Identity, started: number, calls: PersonaUsageSample["calls"], response: { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; toolCalls?: number }, failed: boolean): Promise<void> {
  if (!calls.length) calls.push({ usage: response.usage, durationMs: Math.max(0, performance.now() - started), failed });
  await recordPersonaUsage(repo, persona, identity, {
    at: new Date().toISOString(), calls, interactionDurationMs: Math.max(0, performance.now() - started),
    toolCalls: response.toolCalls, rounds: calls.length, failed,
  });
}

export async function trackedGenerate(repo: string, persona: PersonaId, identity: Identity, provider: ModelProvider, request: ModelRequest): Promise<ModelResponse> {
  const started = performance.now();
  const calls: PersonaUsageSample["calls"] = [];
  try {
    const response = await provider.generate(trackedRequest(request, calls));
    await persist(repo, persona, identity, started, calls, response, false);
    return response;
  } catch (error) {
    await persist(repo, persona, identity, started, calls, {}, true);
    throw error;
  }
}

export async function trackedGenerateWithTools(repo: string, persona: PersonaId, identity: Identity, provider: ToolCapableProvider, request: ToolRequest): Promise<ToolResponse> {
  const started = performance.now();
  const calls: PersonaUsageSample["calls"] = [];
  try {
    const response = await provider.generateWithTools(trackedRequest(request, calls));
    await persist(repo, persona, identity, started, calls, response, false);
    return response;
  } catch (error) {
    await persist(repo, persona, identity, started, calls, {}, true);
    throw error;
  }
}
