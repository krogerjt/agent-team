import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { roster, type PersonaId } from "../personas/roster.js";
import type { ToolDefinition, ToolResult } from "../core/provider.js";
import { repoHome, type TeamRunState } from "./state.js";

export interface TimelineEntry {
  id: string;
  at: string;
  persona: PersonaId;
  event: string;
  summary: string;
  detail: string;
  feature?: string;
  files: string[];
  runId?: string;
  taskId?: string;
  source: "run" | "chat" | "review" | "legacy";
}

export interface TimelineSearch {
  query?: string;
  from?: string;
  to?: string;
  feature?: string;
  file?: string;
  limit?: number;
}

const migration = new Map<string, Promise<void>>();
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

function timelineDir(repo: string, persona: PersonaId): string {
  return path.join(repoHome(repo), "personas", persona, "timeline");
}

function validDate(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.valueOf())) throw new Error(`Invalid timeline timestamp: ${value}`);
  return at.toISOString();
}

function oneLine(value: string, max = 220): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function readableLegacy(entry: TimelineEntry): TimelineEntry {
  if (entry.source !== "legacy") return entry;
  const name = roster[entry.persona].name;
  const subject = entry.feature || "the goal";
  if (entry.event === "tool") {
    const tool = entry.detail.split(" ", 1)[0];
    const match = /"path":"((?:\\.|[^"])*)"/.exec(entry.detail);
    let file: string | undefined;
    if (match) {
      try { file = JSON.parse(`"${match[1]}"`) as string; } catch { file = match[1]; }
    }
    const action: Record<string, string> = { apply_patch: "Patched", read_file: "Read", list_files: "Listed files for", search: "Searched files for" };
    return { ...entry, summary: oneLine(`${name} ${action[tool] ?? `used ${tool}`}${file ? ` ${file}` : ` ${subject}`}`), files: file ? [file.replaceAll("\\", "/")] : entry.files };
  }
  if (entry.event === "started") return { ...entry, summary: oneLine(`${name} started ${subject}`) };
  if (entry.event === "worktree") return { ...entry, summary: oneLine(`Opened ${name}'s worktree for ${subject}`) };
  if (entry.event === "integrated") return { ...entry, summary: oneLine(`${name} completed ${subject}`) };
  if (entry.event === "finished") return { ...entry, summary: oneLine(`${name} finished: ${entry.detail.split("; ").slice(1).join("; ") || subject}`) };
  return entry;
}

function normalizedEntry(persona: PersonaId, input: Omit<TimelineEntry, "id" | "persona">, id?: string): TimelineEntry {
  const at = validDate(input.at);
  return {
    id: id ?? `${at.slice(0, 7)}-${randomUUID()}`,
    at, persona,
    event: oneLine(input.event, 60),
    summary: oneLine(input.summary),
    detail: input.detail.slice(0, 2_000),
    feature: input.feature ? oneLine(input.feature, 200) : undefined,
    files: [...new Set(input.files.map((file) => file.replaceAll("\\", "/").slice(0, 300)))].slice(0, 20),
    runId: input.runId,
    taskId: input.taskId,
    source: input.source,
  };
}

async function appendRaw(repo: string, entry: TimelineEntry): Promise<void> {
  const folder = timelineDir(repo, entry.persona);
  await mkdir(folder, { recursive: true });
  await appendFile(path.join(folder, `${entry.at.slice(0, 7)}.jsonl`), JSON.stringify(entry) + "\n", "utf8");
}

function legacyId(persona: PersonaId, source: string): string {
  const hash = createHash("sha256").update(`${persona}:${source}`).digest("hex").slice(0, 24);
  return hash;
}

async function migratePreviousEvents(repo: string): Promise<void> {
  const home = repoHome(repo);
  const marker = path.join(home, "personas", "timeline-v1.complete");
  try { await access(marker); return; }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  let runNames: string[] = [];
  try { runNames = await readdir(path.join(home, "runs")); }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  for (const runId of runNames.filter((name) => /^\d{10,}-[a-z0-9]{4,12}$/.test(name))) {
    const runDir = path.join(home, "runs", runId);
    let goal = "";
    try { goal = (JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")) as TeamRunState).goal; }
    catch { /* preserve events even if the run state is unavailable */ }
    let events = "";
    try { events = await readFile(path.join(runDir, "events.jsonl"), "utf8"); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const [index, line] of events.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let raw: { at?: string; persona?: string; event?: string; detail?: string };
      try { raw = JSON.parse(line) as typeof raw; } catch { continue; }
      if (!raw.persona || !Object.hasOwn(roster, raw.persona) || !raw.at || Number.isNaN(Date.parse(raw.at))) continue;
      const persona = raw.persona as PersonaId;
      const detail = raw.detail ?? "";
      const entry = normalizedEntry(persona, {
        at: raw.at, event: raw.event ?? "worked", summary: `${roster[persona].name} ${raw.event ?? "worked"}: ${oneLine(detail, 130)}`,
        detail, feature: goal, files: [], runId, source: "legacy",
      }, `${raw.at.slice(0, 7)}-${legacyId(persona, `${runId}:${index}`)}`);
      await appendRaw(repo, entry);
    }
  }
  for (const persona of Object.keys(roster) as PersonaId[]) {
    let profile: { activity?: Array<{ at: string; runId: string; event: string; detail: string }> };
    try { profile = JSON.parse(await readFile(path.join(home, "personas", `${persona}.json`), "utf8")) as typeof profile; }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const [index, item] of (profile.activity ?? []).entries()) {
      if (!item.at || Number.isNaN(Date.parse(item.at))) continue;
      await appendRaw(repo, normalizedEntry(persona, {
        at: item.at, event: item.event, summary: `${roster[persona].name} ${item.event}: ${oneLine(item.detail, 130)}`,
        detail: item.detail, files: [], runId: item.runId, source: "legacy",
      }, `${item.at.slice(0, 7)}-${legacyId(persona, `profile:${index}:${item.at}:${item.detail}`)}`));
    }
  }
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, `${new Date().toISOString()}\n`, "utf8");
}

export async function ensureTimeline(repo: string): Promise<void> {
  const key = repoHome(repo);
  let pending = migration.get(key);
  if (!pending) {
    pending = migratePreviousEvents(repo);
    migration.set(key, pending);
    void pending.catch(() => migration.delete(key));
  }
  await pending;
}

export async function appendTimeline(repo: string, persona: PersonaId, input: Omit<TimelineEntry, "id" | "persona">): Promise<TimelineEntry> {
  await ensureTimeline(repo);
  const entry = normalizedEntry(persona, input);
  await appendRaw(repo, entry);
  return entry;
}

function rangeBoundary(value: string | undefined, side: "from" | "to"): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const normalized = validDate(`${value}T00:00:00.000Z`);
    return side === "to" ? `${normalized.slice(0, 10)}T23:59:59.999Z` : normalized;
  }
  return validDate(value);
}

async function* entriesInFile(file: string): AsyncGenerator<TimelineEntry> {
  const lines = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try { yield readableLegacy(JSON.parse(line) as TimelineEntry); } catch { /* a partial last line is ignored */ }
  }
}

export async function searchTimeline(repo: string, persona: PersonaId, search: TimelineSearch = {}): Promise<{ entries: TimelineEntry[]; total: number }> {
  await ensureTimeline(repo);
  const from = rangeBoundary(search.from, "from");
  const to = rangeBoundary(search.to, "to");
  if (from && to && from > to) throw new Error("Timeline start date must be before the end date.");
  const limit = search.limit ?? 15;
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error("Timeline limit must be 1–30.");
  const terms = (search.query ?? "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  if ((search.query ?? "").length > 200 || (search.feature ?? "").length > 200 || (search.file ?? "").length > 300) throw new Error("Timeline search is too long.");
  const folder = timelineDir(repo, persona);
  let months: string[] = [];
  try { months = await readdir(folder); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { entries: [], total: 0 };
    throw error;
  }
  const selected = months.filter((name) => name.endsWith(".jsonl") && monthPattern.test(name.slice(0, -6)))
    .filter((name) => (!from || name.slice(0, 7) >= from.slice(0, 7)) && (!to || name.slice(0, 7) <= to.slice(0, 7)));
  const matches: TimelineEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const month of selected) {
    for await (const entry of entriesInFile(path.join(folder, month))) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (from && entry.at < from || to && entry.at > to) continue;
      if (search.feature && !entry.feature?.toLowerCase().includes(search.feature.toLowerCase())) continue;
      if (search.file && !entry.files.some((file) => file.toLowerCase().includes(search.file!.toLowerCase()))) continue;
      const haystack = `${entry.summary} ${entry.detail} ${entry.feature ?? ""} ${entry.files.join(" ")} ${entry.event}`.toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) continue;
      total++;
      matches.push(entry);
      matches.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
      if (matches.length > limit) matches.pop();
    }
  }
  return { entries: matches, total };
}

export async function getTimelineEntry(repo: string, persona: PersonaId, id: string): Promise<TimelineEntry | undefined> {
  await ensureTimeline(repo);
  const month = id.slice(0, 7);
  if (!monthPattern.test(month) || !/^\d{4}-\d{2}-[a-z0-9-]{20,}$/.test(id)) throw new Error("Invalid timeline entry ID.");
  const file = path.join(timelineDir(repo, persona), `${month}.jsonl`);
  try {
    for await (const entry of entriesInFile(file)) if (entry.id === id) return entry;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  return undefined;
}

const params = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });
export const memoryTools: ToolDefinition[] = [
  { name: "search_memory", description: "Search your personal, dated work timeline by words, feature, file, or date. Use when asked what you did on a feature or at a time. Returns brief entries with IDs; search before making claims about past work.", parameters: params({ query: { type: "string" }, from: { type: "string", description: "UTC ISO date or timestamp" }, to: { type: "string", description: "UTC ISO date or timestamp" }, feature: { type: "string" }, file: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, []) },
  { name: "get_memory_entry", description: "Read the full stored detail for one personal timeline entry returned by search_memory.", parameters: params({ id: { type: "string" } }, ["id"]) },
];

export async function executeMemoryTool(repo: string, persona: PersonaId, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (name === "search_memory") {
    const filters: TimelineSearch = {};
    for (const key of ["query", "from", "to", "feature", "file"] as const) {
      if (args[key] !== undefined) {
        if (typeof args[key] !== "string") throw new Error(`${key} must be text.`);
        filters[key] = args[key] as string;
      }
    }
    if (args.limit !== undefined) {
      if (typeof args.limit !== "number") throw new Error("limit must be a number.");
      filters.limit = args.limit;
    }
    const result = await searchTimeline(repo, persona, { ...filters, limit: Math.min(filters.limit ?? 10, 20) });
    return { content: JSON.stringify({ total: result.total, entries: result.entries.map(({ id, at, event, summary, feature, files, runId, taskId }) => ({ id, at, event, summary, feature, files, runId, taskId })) }) };
  }
  if (name === "get_memory_entry") {
    if (typeof args.id !== "string") throw new Error("id must be text.");
    const entry = await getTimelineEntry(repo, persona, args.id);
    return { content: entry ? JSON.stringify(entry) : "Timeline entry not found." };
  }
  throw new Error(`Unknown memory tool: ${name}`);
}
