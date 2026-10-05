import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { saveState, type TeamRunState } from "../team/state.js";
import { commandKey, commandRisk, type Cookbook } from "./cookbook.js";
import { getSecret } from "./secrets.js";

export type PreviewStatus = "stopped" | "starting" | "healthy" | "waiting-approval" | "waiting-secret" | "failed";
export interface PreviewInfo {
  status: PreviewStatus;
  url?: string;
  port?: number;
  log: string;
  issue?: string;
  command?: string;
  commandKey?: string;
  secret?: string;
  screenshot?: string;
  captureAt?: string;
  structure?: string;
  browserResults?: Array<{ step: string; status: "passed" | "failed" | "missing"; detail: string }>;
  visualReview?: string;
  visualVerified?: boolean;
}

export class PreviewPause extends Error {
  constructor(readonly kind: "approval" | "secret", readonly value: string, message: string, readonly port: number, readonly key?: string) { super(message); }
}
export class PreviewFailure extends Error {
  constructor(message: string, readonly info: PreviewInfo) { super(message); }
}
export class PreviewStopped extends Error { constructor() { super("Preview was stopped."); } }

const live = new Map<string, { child: ChildProcess; info: PreviewInfo }>();
const cancelled = new Set<string>();
const LIMIT = 12_000;
const rawLogs = new WeakMap<PreviewInfo, string>();
function append(info: PreviewInfo, chunk: string, secrets: string[]): void {
  const raw = ((rawLogs.get(info) ?? "") + chunk).slice(-LIMIT - 20_000);
  rawLogs.set(info, raw);
  let clean = raw;
  for (const secret of secrets) if (secret) {
    clean = clean.replaceAll(secret, "[redacted]");
    for (let size = Math.min(secret.length - 1, 32); size >= 3; size--) {
      if (raw.endsWith(secret.slice(0, size))) { clean = clean.slice(0, -size) + "[redacted]"; break; }
    }
  }
  info.log = clean.slice(-LIMIT);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => address && typeof address !== "string" ? resolve(address.port) : reject(new Error("No preview port."))); });
  });
}

function childCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  return process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/s", "/c", command], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    : spawn("sh", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
}

function baseEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "PATHEXT", "ComSpec"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => resolve()); killer.once("close", () => resolve());
    });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
  }
}

export async function stopPreview(runId: string): Promise<void> {
  cancelled.add(runId);
  const session = live.get(runId);
  if (!session) return;
  live.delete(runId);
  await stopChild(session.child);
  session.info.status = "stopped";
  session.info.url = undefined;
}

export async function stopAllPreviews(): Promise<void> { await Promise.all([...live.keys()].map(stopPreview)); }
export function livePreview(runId: string): PreviewInfo | undefined { return live.get(runId)?.info; }

async function rootInside(worktree: string, relative: string): Promise<string> {
  const root = await realpath(worktree);
  const target = await realpath(path.resolve(root, relative));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Cookbook working directory escapes the worktree.");
  return target;
}

async function execute(runId: string, command: string, cwd: string, env: NodeJS.ProcessEnv, info: PreviewInfo, secrets: string[], timeoutMs: number): Promise<void> {
  if (cancelled.has(runId)) throw new PreviewStopped();
  const child = childCommand(command, cwd, env);
  live.set(runId, { child, info });
  append(info, `\n$ ${command}\n`, secrets);
  child.stdout?.on("data", (chunk: Buffer) => append(info, chunk.toString(), secrets));
  child.stderr?.on("data", (chunk: Buffer) => append(info, chunk.toString(), secrets));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { void stopChild(child); reject(new Error(`Command timed out: ${command}`)); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); if (live.get(runId)?.child === child) live.delete(runId); code === 0 && !cancelled.has(runId) ? resolve() : reject(cancelled.has(runId) ? new PreviewStopped() : new Error(`Command exited ${code}: ${command}`)); });
  });
}

export async function startPreview(state: TeamRunState, book: Cookbook, approvedKeys: string[]): Promise<PreviewInfo> {
  if (!state.staging) throw new Error("No staging worktree exists.");
  await stopPreview(state.id);
  cancelled.delete(state.id);
  const cwd = await rootInside(state.staging.path, book.workingDir);
  const info: PreviewInfo = { status: "starting", log: "" };
  const port = state.preview?.port && ["waiting-approval", "waiting-secret"].includes(state.preview.status) ? state.preview.port : await freePort();
  const values: Record<string, string> = {};
  const secretValues: string[] = [];
  for (const [variable, name] of Object.entries(book.secrets)) {
    const value = await getSecret(name);
    if (value === undefined) throw new PreviewPause("secret", name, `Piper needs the secret '${name}' for ${variable}.`, port);
    values[variable] = value; secretValues.push(value);
  }
  for (const [key, value] of Object.entries(book.variables)) values[key] = value.replaceAll("{port}", String(port));
  const env: NodeJS.ProcessEnv = { ...baseEnvironment(), ...values, PORT: String(port), HOST: "127.0.0.1", AGENT_TEAM_PREVIEW_PORT: String(port) };
  const commands = [...book.setup, ...book.build, book.start].map((command) => command.replaceAll("{port}", String(port)));
  for (const [index, command] of commands.entries()) {
    const reason = await commandRisk(command, cwd);
    const key = commandKey([...book.setup, ...book.build, book.start][index]);
    if (reason && !approvedKeys.includes(key)) throw new PreviewPause("approval", command, reason, port, key);
  }
  try {
    for (const command of commands.slice(0, -1)) await execute(state.id, command, cwd, env, info, secretValues, 120_000);
    if (cancelled.has(state.id)) throw new PreviewStopped();
    const child = childCommand(commands.at(-1)!, cwd, env);
    child.on("error", (error) => { append(info, `\n${error.message}\n`, secretValues); });
    append(info, `\n$ ${commands.at(-1)!}\n`, secretValues);
    child.stdout?.on("data", (chunk: Buffer) => append(info, chunk.toString(), secretValues));
    child.stderr?.on("data", (chunk: Buffer) => append(info, chunk.toString(), secretValues));
    const url = `http://127.0.0.1:${port}${book.healthPath}`;
    live.set(state.id, { child, info });
    child.once("close", (code) => {
      if (live.get(state.id)?.child !== child) return;
      live.delete(state.id);
      info.status = "failed";
      info.issue = `Preview process exited ${code ?? "unexpectedly"}.`;
      if (state.preview) { state.preview.status = "failed"; state.preview.issue = info.issue; }
      void persistPreview(state, info).then(() => saveState(state));
    });
    info.port = port; info.url = url;
    const started = Date.now();
    while (Date.now() - started < 30_000) {
      if (cancelled.has(state.id)) throw new PreviewStopped();
      if (child.exitCode !== null) throw new Error(`Preview process exited ${child.exitCode}.`);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) { info.status = "healthy"; await persistPreview(state, info); return info; }
      } catch { /* still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    throw new Error(`Preview did not become healthy at ${url}.`);
  } catch (error) {
    await stopPreview(state.id);
    info.status = error instanceof PreviewStopped ? "stopped" : "failed";
    info.issue = error instanceof Error ? error.message : String(error);
    await persistPreview(state, info);
    if (error instanceof PreviewStopped) throw error;
    throw new PreviewFailure(info.issue, info);
  }
}

export async function persistPreview(state: TeamRunState, info: PreviewInfo): Promise<void> {
  const folder = path.join(state.runDir, "preview");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "status.json"), JSON.stringify({ ...info, log: info.log.slice(-LIMIT) }, null, 2) + "\n", "utf8");
}
