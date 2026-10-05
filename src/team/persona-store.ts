import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createProvider, resolveProviderConfig, type ProviderName } from "../config.js";
import type { ModelProvider } from "../core/provider.js";
import { roster, type PersonaId } from "../personas/roster.js";
import { repoHome } from "./state.js";
import { searchTimeline } from "./timeline.js";

export interface PersonaActivity { at: string; runId: string; event: string; detail: string }
export interface PersonaChat { at: string; role: "user" | "assistant"; text: string; runId?: string }
export interface PersonaProfile {
  id: PersonaId;
  traits: string;
  memory: string;
  activity: PersonaActivity[];
  chat: PersonaChat[];
  provider?: ProviderName;
  model?: string;
}

const ids = Object.keys(roster) as PersonaId[];
const writes = new Map<string, Promise<void>>();
const defaultTraits: Record<PersonaId, string> = {
  marlow: "Calm, seasoned, and clear. Breaks large goals into small steps, names dependencies, and brings decisions back to the user.",
  juniper: "Curious and thorough. Reads the whole trail before touching a problem and quotes repository evidence when giving advice.",
  kit: "Cheerful and practical. Likes a working build, a focused patch, and a second test run for confidence.",
  wren: "Warm, observant, and exacting about little interface details. Thinks about the person using every screen.",
  rowan: "Patient and meticulous. Untangles code carefully and gives direct, constructive reviews.",
  tove: "Organized and kind. Keeps durable notes, checks claims against evidence, and leaves a clear trail for the next run.",
};
export function isPersonaId(value: string): value is PersonaId { return ids.includes(value as PersonaId); }

function file(repo: string, id: PersonaId): string {
  return path.join(repoHome(repo), "personas", `${id}.json`);
}

function initial(id: PersonaId): PersonaProfile {
  return { id, traits: defaultTraits[id], memory: "", activity: [], chat: [] };
}

export async function readPersona(repo: string, id: PersonaId): Promise<PersonaProfile> {
  try {
    const value = JSON.parse(await readFile(file(repo, id), "utf8")) as Partial<PersonaProfile>;
    return { ...initial(id), ...value, id, activity: value.activity ?? [], chat: value.chat ?? [] };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return initial(id);
    throw error;
  }
}

async function savePersona(repo: string, profile: PersonaProfile): Promise<void> {
  const destination = file(repo, profile.id);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(profile, null, 2) + "\n", "utf8");
  await rename(temporary, destination);
}

async function mutatePersona(repo: string, id: PersonaId, change: (profile: PersonaProfile) => void): Promise<PersonaProfile> {
  const key = file(repo, id);
  const previous = writes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const next = previous.then(() => gate);
  writes.set(key, next);
  await previous;
  try {
    const profile = await readPersona(repo, id);
    change(profile);
    await savePersona(repo, profile);
    return profile;
  } finally {
    release();
    if (writes.get(key) === next) writes.delete(key);
  }
}

export async function updatePersona(repo: string, id: PersonaId, patch: {
  traits?: string; memory?: string; provider?: ProviderName; model?: string;
}): Promise<PersonaProfile> {
  return mutatePersona(repo, id, (profile) => {
    if (patch.traits !== undefined) profile.traits = patch.traits.slice(0, 4_000);
    if (patch.memory !== undefined) profile.memory = patch.memory.slice(0, 12_000);
    if (patch.provider !== undefined) profile.provider = patch.provider;
    if (patch.model !== undefined) profile.model = patch.model.trim().slice(0, 200);
    if (profile.provider && profile.provider !== "mock" && !profile.model) throw new Error("Enter a model name for this provider.");
  });
}

export async function appendActivity(repo: string, id: PersonaId, item: PersonaActivity): Promise<void> {
  await mutatePersona(repo, id, (profile) => {
    profile.activity.unshift({ ...item, detail: item.detail.slice(0, 500) });
    profile.activity = profile.activity.slice(0, 100);
  });
}

export async function appendChat(repo: string, id: PersonaId, item: PersonaChat): Promise<void> {
  await mutatePersona(repo, id, (profile) => {
    profile.chat.push({ ...item, text: item.text.slice(0, 8_000) });
    profile.chat = profile.chat.slice(-100);
  });
}

export async function personaContext(repo: string, id: PersonaId): Promise<string> {
  const profile = await readPersona(repo, id);
  const recent = (await searchTimeline(repo, id, { limit: 5 })).entries.map((item) => `${item.at}: ${item.summary}`).join("\n");
  return `Personal traits: ${profile.traits}\nPinned memory: ${profile.memory || "(empty)"}\nRecent timeline:\n${recent || "(none yet)"}\nFor questions about previous work, features, files, or dates, use search_memory and get_memory_entry before answering. Distinguish recorded actions from verified results.`;
}

export async function configuredProvider(repo: string, id: PersonaId): Promise<ModelProvider> {
  const profile = await readPersona(repo, id);
  if (!profile.provider) return createProvider(id);
  const prefix = id.toUpperCase();
  return createProvider(id, { ...process.env, [`${prefix}_PROVIDER`]: profile.provider, [`${prefix}_MODEL`]: profile.model ?? "" });
}

export async function effectiveModel(repo: string, id: PersonaId): Promise<{ provider: ProviderName; model?: string }> {
  const profile = await readPersona(repo, id);
  if (profile.provider) return { provider: profile.provider, model: profile.model };
  try { return resolveProviderConfig(id); }
  catch { return { provider: "mock" }; }
}
