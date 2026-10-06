import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface RemoteBuildHost {
  enabled: boolean;
  target: string;
  port?: number;
  root: string;
}

export interface RemoteProjectSettings {
  setupCommand: string;
  secrets: Record<string, string>;
}

const initialHost: RemoteBuildHost = { enabled: false, target: "", root: ".agent-team-builder" };
const initialProject: RemoteProjectSettings = { setupCommand: "", secrets: {} };

function dataRoot(): string {
  return process.env.AGENT_TEAM_DATA_DIR ? path.resolve(process.env.AGENT_TEAM_DATA_DIR) : path.join(os.homedir(), ".agent-team");
}

function hostFile(): string { return path.join(dataRoot(), "remote-build-host.json"); }
function projectFile(repo: string): string {
  const resolved = path.resolve(repo);
  const hash = createHash("sha256").update(resolved.toLowerCase()).digest("hex").slice(0, 12);
  return path.join(dataRoot(), "repos", `${path.basename(resolved)}-${hash}`, "remote-build.json");
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

export function validateRemoteBuildHost(input: RemoteBuildHost): RemoteBuildHost {
  const target = String(input.target ?? "").trim();
  const root = String(input.root || initialHost.root).trim();
  if (target && (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$/.test(target) || target.startsWith("-"))) throw new Error("Enter an SSH alias or user@host without spaces.");
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) throw new Error("SSH port must be between 1 and 65535.");
  if (!/^[A-Za-z0-9.][A-Za-z0-9._/-]{0,199}$/.test(root) || path.posix.isAbsolute(root) || root === "." || root.split("/").includes("..")) throw new Error("Remote cache root must be a relative path inside the Mac user's home folder.");
  if (input.enabled && !target) throw new Error("Enter an SSH target before enabling the Mac build host.");
  return { enabled: Boolean(input.enabled), target, ...(input.port ? { port: input.port } : {}), root };
}

function validatedProject(input: RemoteProjectSettings): RemoteProjectSettings {
  const setupCommand = String(input.setupCommand ?? "").trim();
  if (setupCommand.length > 2_000) throw new Error("Preparation command is limited to 2,000 characters.");
  const secrets: Record<string, string> = {};
  for (const [variable, name] of Object.entries(input.secrets ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(variable)) throw new Error(`Invalid environment variable: ${variable}`);
    if (!/^[A-Za-z][A-Za-z0-9_.:/-]{0,99}$/.test(name)) throw new Error(`Invalid Keychain secret name: ${name}`);
    secrets[variable] = name;
  }
  return { setupCommand, secrets };
}

export async function readRemoteBuildHost(): Promise<RemoteBuildHost> {
  return validateRemoteBuildHost({ ...initialHost, ...await readJson<Partial<RemoteBuildHost>>(hostFile(), {}) } as RemoteBuildHost);
}
export async function saveRemoteBuildHost(input: RemoteBuildHost): Promise<RemoteBuildHost> {
  const value = validateRemoteBuildHost(input); await atomicWrite(hostFile(), value); return value;
}
export async function readRemoteProjectSettings(repo: string): Promise<RemoteProjectSettings> {
  return validatedProject({ ...initialProject, ...await readJson<Partial<RemoteProjectSettings>>(projectFile(repo), {}) } as RemoteProjectSettings);
}
export async function saveRemoteProjectSettings(repo: string, input: RemoteProjectSettings): Promise<RemoteProjectSettings> {
  const value = validatedProject(input); await atomicWrite(projectFile(repo), value); return value;
}

export async function suggestedSetupCommand(repo: string): Promise<string> {
  const exists = async (name: string) => { try { await readFile(path.join(repo, name)); return true; } catch { return false; } };
  if (await exists("Podfile")) return await exists("Gemfile") ? "bundle exec pod install" : "pod install";
  return "";
}
