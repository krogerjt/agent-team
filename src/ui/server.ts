import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../coding/git.js";
import { roster, type PersonaId } from "../personas/roster.js";
import { effectiveModel, isPersonaId, readPersona, updatePersona } from "../team/persona-store.js";
import { loadState, readLibrary, repoHome, saveState, subscribeToRunEvents, type RunEvent, type TeamRunState } from "../team/state.js";
import { answerTeamRun, chatTeamPersona, mergeTeamRun, messageTeamPersona, reviewTeamRun, runTeamGoal, resumeTeamPreview, startTeamPreview } from "../team/workflow.js";
import { getTimelineEntry, searchTimeline } from "../team/timeline.js";
import { listSecrets, setSecret } from "../preview/secrets.js";
import { livePreview, stopAllPreviews, stopPreview } from "../preview/runtime.js";
import { readCookbook } from "../preview/cookbook.js";
import { runPerformanceReview } from "../team/performance-review.js";
import { recentRepositories, rememberRepository, resolveRepository } from "./repositories.js";
import { commitLocalChanges, finishRunUpdate, mergeReadiness, repositoryGitStatus, resolveRunConflict, updateRunToLatest } from "../team/git-actions.js";
import { readRemoteBuildHost, readRemoteProjectSettings, saveRemoteBuildHost, saveRemoteProjectSettings, suggestedSetupCommand, type RemoteBuildHost, type RemoteProjectSettings } from "../remote/settings.js";
import { saveRemoteKeychainSecret, testRemoteBuildHost } from "../remote/executor.js";
import { detectChecks } from "../coding/checks.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const repoArg = process.argv[2] ?? ".";
const port = Number(process.env.AGENT_TEAM_PORT ?? 4173);
const jobs = new Map<string, { status: "running" | "done" | "error"; repo: string; runId?: string; error?: string }>();
const activeRuns = new Set<string>();
const activeReviews = new Set<PersonaId>();
const apiToken = randomUUID();
let switchingRepository = false;
let activeMutations = 0;
const gitLocks = new Set<string>();
const eventStreams = new Map<string, Set<ServerResponse>>();

subscribeToRunEvents((runId, event) => {
  const listeners = eventStreams.get(runId);
  if (!listeners) return;
  const payload = `event: run-event\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of listeners) {
    try { client.write(payload); } catch { listeners.delete(client); }
  }
  if (!listeners.size) eventStreams.delete(runId);
});

function assertRepositoryIdle(repo: string): void {
  if (activeMutations > 1 || [...jobs.values()].some((job) => job.repo === repo && job.status === "running") || activeReviews.size) throw new Error("Wait for the current work to finish before changing Git history.");
}

async function gitAction<T>(repo: string, work: () => Promise<T>): Promise<T> {
  if (gitLocks.has(repo)) throw new Error("A Git action is already running.");
  gitLocks.add(repo);
  try { return await work(); } finally { gitLocks.delete(repo); }
}

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

async function readRunEvents(runDir: string, limit = 200): Promise<RunEvent[]> {
  let contents = "";
  try { contents = await readFile(path.join(runDir, "events.jsonl"), "utf8"); } catch { return []; }
  return contents.trim().split("\n").filter(Boolean).slice(-Math.min(Math.max(limit, 1), 500)).map((line) => JSON.parse(line) as RunEvent);
}

async function hasAppleProject(repo: string): Promise<boolean> {
  return (await detectChecks(repo)).some((command) => command.platform === "darwin");
}

function launch(repo: string, work: () => Promise<TeamRunState>, initialRunId?: string): string {
  const id = randomUUID();
  jobs.set(id, { status: "running", repo, runId: initialRunId });
  void work().then((state) => {
    jobs.set(id, { status: "done", repo, runId: state.id });
    activeRuns.delete(state.id);
  }).catch((error: unknown) => {
    jobs.set(id, { status: "error", repo, runId: initialRunId, error: error instanceof Error ? error.message : String(error) });
    if (initialRunId) activeRuns.delete(initialRunId);
  });
  return id;
}

async function serve(req: IncomingMessage, res: ServerResponse, workspace: { repo: string }): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const method = req.method ?? "GET";
  if (method !== "GET") {
    const origin = req.headers.origin;
    if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) throw new Error("Request origin is not this workshop.");
    if (req.headers["x-agent-team-token"] !== apiToken) throw new Error("Workshop request token is missing.");
    if (switchingRepository) throw new Error("The workshop is switching repositories. Try again in a moment.");
    if (gitLocks.has(workspace.repo)) throw new Error("Wait for the current Git action to finish.");
    const expectedRepo = req.headers["x-agent-team-repository"];
    if (expectedRepo !== encodeURIComponent(workspace.repo)) throw new Error("The repository changed in another tab. Refresh the workshop before continuing.");
  }
  if (method === "POST" && url.pathname === "/api/repositories/select") {
    if (activeMutations > 1 || [...jobs.values()].some((job) => job.status === "running") || activeReviews.size) throw new Error("Wait for the team to finish its current work before switching repositories.");
    switchingRepository = true;
    try {
      const input = await body(req);
      const repo = await resolveRepository(string(input.path, "a repository path", 2_000));
      const repositories = await rememberRepository(repo);
      await stopAllPreviews();
      workspace.repo = repo;
      json(res, 200, { repo, repositories }); return;
    } finally { switchingRepository = false; }
  }
  const repo = workspace.repo;
  if (method === "GET" && url.pathname === "/api/git/status") { json(res, 200, await repositoryGitStatus(repo)); return; }
  if (method === "POST" && url.pathname === "/api/git/commit") {
    assertRepositoryIdle(repo);
    const status = await gitAction(repo, async () => {
      const input = await body(req);
      if (!Array.isArray(input.files) || input.files.some((file) => typeof file !== "string")) throw new Error("Choose files to save.");
      return commitLocalChanges(repo, string(input.message, "a commit message", 500), input.files as string[], string(input.head, "the reviewed commit", 64));
    });
    json(res, 200, status); return;
  }
  if (method === "GET" && url.pathname === "/api/bootstrap") {
    const ids = Object.keys(roster) as PersonaId[];
    const profiles = await Promise.all(ids.map(async (id) => ({ ...await readPersona(repo, id), effective: await effectiveModel(repo, id), ...roster[id] })));
    const repoJobs = Object.fromEntries([...jobs].filter(([, job]) => job.repo === repo));
    const remoteHost = await readRemoteBuildHost();
    json(res, 200, { repo, repositories: await recentRepositories(), head: await git(repo, ["rev-parse", "HEAD"]), profiles, runs: await runs(repo), library: await readLibrary({ libraryPath: path.join(repoHome(repo), "library.md") }), jobs: repoJobs, apiToken, appleProject: await hasAppleProject(repo), remoteHost: { enabled: remoteHost.enabled, target: remoteHost.target } });
    return;
  }
  if (method === "GET" && url.pathname === "/api/analytics") {
    const ids = Object.keys(roster) as PersonaId[];
    const analytics = await Promise.all(ids.map(async (id) => {
      const profile = await readPersona(repo, id);
      return { persona: id, name: roster[id].name, modelStats: profile.modelStats ?? [] };
    }));
    json(res, 200, { repo, personas: analytics });
    return;
  }
  if (url.pathname === "/api/options/mac-host") {
    if (method === "GET") {
      const host = await readRemoteBuildHost();
      const project = await readRemoteProjectSettings(repo);
      const suggested = project.setupCommand || await suggestedSetupCommand(repo);
      const appleChecks = (await detectChecks(repo)).filter((check) => check.platform === "darwin").map((check) => check.name);
      json(res, 200, { host, project: { ...project, setupCommand: suggested }, appleChecks }); return;
    }
    if (method === "PUT") {
      const input = await body(req);
      const host = await saveRemoteBuildHost({ enabled: Boolean(input.enabled), target: String(input.target ?? ""), port: input.port === "" || input.port === undefined ? undefined : Number(input.port), root: String(input.root ?? "") });
      json(res, 200, { host }); return;
    }
  }
  if (method === "POST" && url.pathname === "/api/options/mac-host/test") {
    const input = await body(req);
    const current = await readRemoteBuildHost();
    const host: RemoteBuildHost = input.target === undefined ? current : { enabled: Boolean(input.enabled), target: String(input.target), port: input.port === "" || input.port === undefined ? undefined : Number(input.port), root: String(input.root || ".agent-team-builder") };
    const project = await readRemoteProjectSettings(repo);
    json(res, 200, await testRemoteBuildHost(host, project.setupCommand)); return;
  }
  if (method === "PUT" && url.pathname === "/api/options/mac-project") {
    const input = await body(req);
    const secrets = input.secrets && typeof input.secrets === "object" && !Array.isArray(input.secrets) ? input.secrets as Record<string, string> : {};
    const project = await saveRemoteProjectSettings(repo, { setupCommand: String(input.setupCommand ?? ""), secrets } as RemoteProjectSettings);
    json(res, 200, { project }); return;
  }
  if (method === "POST" && url.pathname === "/api/options/mac-secret") {
    const input = await body(req);
    const host = await readRemoteBuildHost();
    if (!host.target) throw new Error("Configure the Mac Build Host before saving a Keychain secret.");
    await saveRemoteKeychainSecret(host, string(input.name, "a Keychain secret name", 100), string(input.value, "a secret value", 20_000));
    json(res, 200, { saved: true }); return;
  }
  if (url.pathname === "/api/secrets") {
    if (method === "GET") { json(res, 200, { names: await listSecrets() }); return; }
    if (method === "POST") {
      const input = await body(req);
      await setSecret(string(input.name, "a secret name", 100), string(input.value, "a secret value", 20_000));
      json(res, 200, { names: await listSecrets() }); return;
    }
  }
  if (method === "GET" && url.pathname.startsWith("/api/jobs/")) {
    json(res, 200, jobs.get(url.pathname.slice(10)) ?? { status: "error", error: "Job not found." });
    return;
  }
  const checkArtifactMatch = /^\/api\/runs\/([^/]+)\/check-artifact$/.exec(url.pathname);
  if (method === "GET" && checkArtifactMatch) {
    if (url.searchParams.get("token") !== apiToken) throw new Error("Workshop request token is missing.");
    const runDir = runPath(repo, checkArtifactMatch[1]);
    const relative = url.searchParams.get("path") ?? "";
    if (!relative || path.isAbsolute(relative) || relative.replaceAll("\\", "/").split("/").includes("..")) throw new Error("Invalid check artifact path.");
    const base = path.resolve(runDir);
    const target = path.resolve(base, relative);
    if (!target.startsWith(base + path.sep)) throw new Error("Check artifact escapes the run directory.");
    const bytes = await readFile(target);
    const contentType = /\.png$/i.test(target) ? "image/png" : /\.jpe?g$/i.test(target) ? "image/jpeg" : "application/json; charset=utf-8";
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(bytes); return;
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
  const personaMatch = /^\/api\/personas\/([^/]+)(\/(?:chat|performance-review))?$/.exec(url.pathname);
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
    if (method === "POST" && personaMatch[2] === "/chat") {
      const input = await body(req);
      const message = string(input.message, "a message");
      const reply = input.runId ? await messageTeamPersona(runPath(repo, string(input.runId, "a run ID", 100)), id, message) : await chatTeamPersona(repo, id, message);
      json(res, 200, { reply, profile: await readPersona(repo, id) }); return;
    }
    if (method === "POST" && personaMatch[2] === "/performance-review") {
      if (activeReviews.has(id)) throw new Error(`${roster[id].name} already has a performance review in progress.`);
      activeReviews.add(id);
      try {
        const evaluation = await runPerformanceReview(repo, id);
        json(res, 200, { evaluation, profile: await readPersona(repo, id) });
      } finally { activeReviews.delete(id); }
      return;
    }
  }
  if (method === "POST" && url.pathname === "/api/goals") {
    const input = await body(req);
    const goal = string(input.goal, "a goal", 4_000);
    const jobId = launch(repo, () => runTeamGoal(repo, goal));
    json(res, 202, { jobId }); return;
  }
  const runMatch = /^\/api\/runs\/([^/]+)(?:\/(review|events|answer|merge|update|finish-update|resolve-conflict|review-preview))?$/.exec(url.pathname);
  if (runMatch) {
    const runDir = runPath(repo, runMatch[1]);
    const action = runMatch[2];
    if (method === "GET" && !action) { json(res, 200, await loadState(runDir)); return; }
    if (method === "GET" && action === "review") { const review = await reviewTeamRun(runDir); json(res, 200, { ...review, readiness: await mergeReadiness(review.state) }); return; }
    if (method === "GET" && action === "events") {
      const requested = Number(url.searchParams.get("limit") ?? "200");
      json(res, 200, await readRunEvents(runDir, Number.isFinite(requested) ? requested : 200)); return;
    }
    if (method === "POST" && action === "answer") {
      if (activeRuns.has(runMatch[1])) throw new Error("This run is already working.");
      const input = await body(req);
      const answer = string(input.answer, "an answer");
      activeRuns.add(runMatch[1]);
      json(res, 202, { jobId: launch(repo, () => answerTeamRun(runDir, answer), runMatch[1]) }); return;
    }
    if (method === "POST" && action === "merge") {
      assertRepositoryIdle(repo);
      json(res, 200, await gitAction(repo, () => mergeTeamRun(runDir))); return;
    }
    if (method === "POST" && ["update", "finish-update", "review-preview"].includes(action ?? "")) {
      assertRepositoryIdle(repo);
      const input = await body(req);
      const expectedHead = action === "update" ? string(input.head, "the reviewed commit", 64) : undefined;
      if (action === "review-preview" && !(await loadState(runDir)).needsPreviewReview) throw new Error("This run does not need a fresh preview review.");
      assertRepositoryIdle(repo);
      const jobId = launch(repo, () => gitAction(repo, () => action === "update" ? updateRunToLatest(runDir, expectedHead!) : action === "finish-update" ? finishRunUpdate(runDir) : resumeTeamPreview(runDir)), runMatch[1]);
      json(res, 202, { jobId }); return;
    }
    if (method === "POST" && action === "resolve-conflict") {
      assertRepositoryIdle(repo);
      const input = await body(req);
      if (input.choice !== "current" && input.choice !== "team") throw new Error("Choose a conflict version.");
      assertRepositoryIdle(repo);
      json(res, 200, await gitAction(repo, () => resolveRunConflict(runDir, string(input.file, "a conflict file", 2_000), input.choice as "current" | "team"))); return;
    }
  }
  const eventStreamMatch = /^\/api\/runs\/([^/]+)\/events\/stream$/.exec(url.pathname);
  if (method === "GET" && eventStreamMatch) {
    const runDir = runPath(repo, eventStreamMatch[1]);
    await loadState(runDir);
    const listeners = eventStreams.get(eventStreamMatch[1]) ?? new Set<ServerResponse>();
    eventStreams.set(eventStreamMatch[1], listeners);
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`event: ready\ndata: ${JSON.stringify({ runId: eventStreamMatch[1] })}\n\n`);
    listeners.add(res);
    const cleanup = () => { listeners.delete(res); if (!listeners.size) eventStreams.delete(eventStreamMatch[1]); };
    req.on("close", cleanup);
    const heartbeat = setInterval(() => { try { res.write(": heartbeat\\n\\n"); } catch { cleanup(); clearInterval(heartbeat); } }, 15_000);
    req.on("close", () => clearInterval(heartbeat));
    return;
  }
  const previewMatch = /^\/api\/runs\/([^/]+)\/preview(?:\/(start|stop|resolve|screenshot))?$/.exec(url.pathname);
  if (previewMatch) {
    const runDir = runPath(repo, previewMatch[1]);
    const action = previewMatch[2];
    const state = await loadState(runDir);
    if (method === "GET" && !action) { const current = livePreview(state.id); json(res, 200, { ...state.preview, ...current, live: current?.status === "healthy", cookbook: await readCookbook(repo) }); return; }
    if (method === "GET" && action === "screenshot") {
      if (!state.preview?.screenshot || !state.preview.screenshot.startsWith(path.join(runDir, "preview") + path.sep)) { json(res, 404, { error: "No screenshot yet." }); return; }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(await readFile(state.preview.screenshot)); return;
    }
    if (method === "POST" && action === "stop") {
      await stopPreview(state.id);
      if (state.preview) { state.preview.status = "stopped"; state.preview.url = undefined; await saveState(state); }
      json(res, 200, { status: "stopped" }); return;
    }
    if (method === "POST" && action === "start") { if (activeRuns.has(state.id)) throw new Error("This run is already working."); activeRuns.add(state.id); json(res, 202, { jobId: launch(repo, () => startTeamPreview(runDir), state.id) }); return; }
    if (method === "POST" && action === "resolve") {
      if (activeRuns.has(state.id)) throw new Error("This run is already working.");
      const input = await body(req);
      if (input.action === "reject") { json(res, 200, { status: "blocked" }); return; }
      if (input.action === "secret") {
        if (state.preview?.status !== "waiting-secret" || input.name !== state.preview.secret) throw new Error("This secret is not requested by Piper.");
        await setSecret(string(input.name, "a secret name", 100), string(input.value, "a secret value", 20_000));
      } else if (input.action !== "approve" || state.preview?.status !== "waiting-approval") throw new Error("No command is awaiting approval.");
      const approved = input.action === "approve" ? state.preview.command : undefined;
      activeRuns.add(state.id);
      json(res, 202, { jobId: launch(repo, () => resumeTeamPreview(runDir, approved), state.id) }); return;
    }
  }
  const assets: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/performance.css": ["performance.css", "text/css; charset=utf-8"],
    "/git-tools.css": ["git-tools.css", "text/css; charset=utf-8"],
    "/remote.css": ["remote.css", "text/css; charset=utf-8"],
    "/status.css": ["status.css", "text/css; charset=utf-8"],
  };
  if (method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204, { "Cache-Control": "no-store" }); res.end(); return;
  }
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
  const repo = await resolveRepository(repoArg);
  await rememberRepository(repo);
  const workspace = { repo };
  const server = createServer((req, res) => {
    const mutation = req.method !== "GET";
    if (mutation) activeMutations++;
    void serve(req, res, workspace).catch((error: unknown) => json(res, 400, { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { if (mutation) activeMutations--; });
  });
  server.listen(port, "127.0.0.1", () => console.log(`Agent Team workshop: http://127.0.0.1:${port}\nRepository: ${repo}`));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void stopAllPreviews().finally(() => server.close()); });
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
