import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../coding/git.js";
import { roster, type PersonaId } from "../personas/roster.js";
import { effectiveModel, isPersonaId, readPersona, updatePersona } from "../team/persona-store.js";
import { loadState, readLibrary, repoHome, type TeamRunState } from "../team/state.js";
import { answerTeamRun, chatTeamPersona, mergeTeamRun, messageTeamPersona, reviewTeamRun, runTeamGoal } from "../team/workflow.js";
import { getTimelineEntry, searchTimeline } from "../team/timeline.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const repoArg = process.argv[2] ?? ".";
const port = Number(process.env.AGENT_TEAM_PORT ?? 4173);
const jobs = new Map<string, { status: "running" | "done" | "error"; runId?: string; error?: string }>();
const activeRuns = new Set<string>();

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) {
    text += chunk.toString();
    if (text.length > 30_000) throw new Error("Request is too large.");
  }
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("Send JSON content.");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, max = 8_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Enter ${label} (${max} characters maximum).`);
  return value.trim();
}

function runPath(repo: string, id: string): string {
  if (!/^\d{10,}-[a-z0-9]{4,12}$/.test(id)) throw new Error("Invalid run ID.");
  return path.join(repoHome(repo), "runs", id);
}

async function runs(repo: string): Promise<TeamRunState[]> {
  let names: string[];
  try { names = await readdir(path.join(repoHome(repo), "runs")); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const states = await Promise.all(names.filter((name) => /^\d{10,}-[a-z0-9]{4,12}$/.test(name)).map(async (name) => {
    try { return await loadState(runPath(repo, name)); } catch { return undefined; }
  }));
  return states.filter((state): state is TeamRunState => Boolean(state)).sort((a, b) => b.id.localeCompare(a.id)).slice(0, 40);
}

function launch(work: () => Promise<TeamRunState>, initialRunId?: string): string {
  const id = randomUUID();
  jobs.set(id, { status: "running", runId: initialRunId });
  void work().then((state) => {
    jobs.set(id, { status: "done", runId: state.id });
    activeRuns.delete(state.id);
  }).catch((error: unknown) => {
    jobs.set(id, { status: "error", runId: initialRunId, error: error instanceof Error ? error.message : String(error) });
    if (initialRunId) activeRuns.delete(initialRunId);
  });
  return id;
}

async function serve(req: IncomingMessage, res: ServerResponse, repo: string): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const method = req.method ?? "GET";
  if (method !== "GET") {
    const origin = req.headers.origin;
    if (origin && new URL(origin).hostname !== "127.0.0.1" && new URL(origin).hostname !== "localhost") throw new Error("Request origin is not local.");
  }
  if (method === "GET" && url.pathname === "/api/bootstrap") {
    const ids = Object.keys(roster) as PersonaId[];
    const profiles = await Promise.all(ids.map(async (id) => ({ ...await readPersona(repo, id), effective: await effectiveModel(repo, id), ...roster[id] })));
    json(res, 200, { repo, head: await git(repo, ["rev-parse", "HEAD"]), profiles, runs: await runs(repo), library: await readLibrary({ libraryPath: path.join(repoHome(repo), "library.md") }), jobs: Object.fromEntries(jobs) });
    return;
  }
  if (method === "GET" && url.pathname.startsWith("/api/jobs/")) {
    json(res, 200, jobs.get(url.pathname.slice(10)) ?? { status: "error", error: "Job not found." });
    return;
  }
  const timelineMatch = /^\/api\/personas\/([^/]+)\/timeline(?:\/([^/]+))?$/.exec(url.pathname);
  if (method === "GET" && timelineMatch) {
    const id = timelineMatch[1];
    if (!isPersonaId(id)) throw new Error("Unknown agent.");
    if (timelineMatch[2]) {
      const entry = await getTimelineEntry(repo, id, timelineMatch[2]);
      json(res, entry ? 200 : 404, entry ?? { error: "Timeline entry not found." });
    } else {
      const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
      json(res, 200, await searchTimeline(repo, id, {
        query: url.searchParams.get("query") ?? undefined,
        from: url.searchParams.get("from") ?? undefined,
        to: url.searchParams.get("to") ?? undefined,
        feature: url.searchParams.get("feature") ?? undefined,
        file: url.searchParams.get("file") ?? undefined,
        limit,
      }));
    }
    return;
  }
  const personaMatch = /^\/api\/personas\/([^/]+)(\/chat)?$/.exec(url.pathname);
  if (personaMatch) {
    const id = personaMatch[1];
    if (!isPersonaId(id)) throw new Error("Unknown agent.");
    if (method === "GET" && !personaMatch[2]) { json(res, 200, { ...await readPersona(repo, id), effective: await effectiveModel(repo, id) }); return; }
    if (method === "PATCH" && !personaMatch[2]) {
      const input = await body(req);
      const patch: { traits?: string; memory?: string; provider?: "mock" | "openai" | "anthropic" | "bedrock"; model?: string } = {};
      for (const field of ["traits", "memory", "model"] as const) {
        if (input[field] !== undefined) {
          if (typeof input[field] !== "string") throw new Error(`${field} must be text.`);
          patch[field] = input[field] as string;
        }
      }
      if (input.provider !== undefined) {
        if (!["mock", "openai", "anthropic", "bedrock"].includes(String(input.provider))) throw new Error("Unknown provider.");
        patch.provider = input.provider as typeof patch.provider;
      }
      json(res, 200, { ...await updatePersona(repo, id, patch), effective: await effectiveModel(repo, id) }); return;
    }
    if (method === "POST" && personaMatch[2]) {
      const input = await body(req);
      const message = string(input.message, "a message");
      const reply = input.runId ? await messageTeamPersona(runPath(repo, string(input.runId, "a run ID", 100)), id, message) : await chatTeamPersona(repo, id, message);
      json(res, 200, { reply, profile: await readPersona(repo, id) }); return;
    }
  }
  if (method === "POST" && url.pathname === "/api/goals") {
    const input = await body(req);
    const goal = string(input.goal, "a goal", 4_000);
    const jobId = launch(() => runTeamGoal(repo, goal));
    json(res, 202, { jobId }); return;
  }
  const runMatch = /^\/api\/runs\/([^/]+)(?:\/(review|events|answer|merge))?$/.exec(url.pathname);
  if (runMatch) {
    const runDir = runPath(repo, runMatch[1]);
    const action = runMatch[2];
    if (method === "GET" && !action) { json(res, 200, await loadState(runDir)); return; }
    if (method === "GET" && action === "review") { json(res, 200, await reviewTeamRun(runDir)); return; }
    if (method === "GET" && action === "events") {
      let contents = "";
      try { contents = await readFile(path.join(runDir, "events.jsonl"), "utf8"); } catch { /* no events yet */ }
      json(res, 200, contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))); return;
    }
    if (method === "POST" && action === "answer") {
      if (activeRuns.has(runMatch[1])) throw new Error("This run is already working.");
      const input = await body(req);
      const answer = string(input.answer, "an answer");
      activeRuns.add(runMatch[1]);
      json(res, 202, { jobId: launch(() => answerTeamRun(runDir, answer), runMatch[1]) }); return;
    }
    if (method === "POST" && action === "merge") {
      if (activeRuns.has(runMatch[1])) throw new Error("Wait for this run to finish.");
      json(res, 200, await mergeTeamRun(runDir)); return;
    }
  }
  const assets: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  };
  if (method === "GET" && assets[url.pathname]) {
    const [name, contentType] = assets[url.pathname];
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(await readFile(path.join(root, name)));
    return;
  }
  json(res, 404, { error: "Not found." });
}

async function main(): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AGENT_TEAM_PORT must be a valid port.");
  const repo = await git(path.resolve(repoArg), ["rev-parse", "--show-toplevel"]);
  const server = createServer((req, res) => {
    void serve(req, res, repo).catch((error: unknown) => json(res, 400, { error: error instanceof Error ? error.message : String(error) }));
  });
  server.listen(port, "127.0.0.1", () => console.log(`Agent Team workshop: http://127.0.0.1:${port}\nRepository: ${repo}`));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
