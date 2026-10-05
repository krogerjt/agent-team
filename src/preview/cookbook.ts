import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { repoHome } from "../team/state.js";

export interface Cookbook {
  version: 1;
  workingDir: string;
  setup: string[];
  build: string[];
  start: string;
  healthPath: string;
  variables: Record<string, string>;
  secrets: Record<string, string>;
}

export function cookbookPath(repo: string): string { return path.join(repoHome(repo), "environment-cookbook.json"); }

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const entries = Object.entries(value);
  if (entries.length > 30 || entries.some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string" || item.length > 500)) throw new Error(`Invalid ${label}.`);
  return Object.fromEntries(entries) as Record<string, string>;
}

export function parseCookbook(value: unknown): Cookbook {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Cookbook must be an object.");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error("Cookbook version must be 1.");
  const workingDir = raw.workingDir ?? ".";
  if (typeof workingDir !== "string" || workingDir.length > 200 || path.isAbsolute(workingDir) || workingDir.split(/[\\/]/).includes("..")) throw new Error("Cookbook working directory must stay in the worktree.");
  const commands = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value) || value.length > 8 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 500 || /[\r\n\0]/.test(item))) throw new Error(`Invalid ${label} commands.`);
    return value as string[];
  };
  const setup = commands(raw.setup ?? [], "setup");
  const build = commands(raw.build ?? [], "build");
  if (typeof raw.start !== "string" || !raw.start.trim() || raw.start.length > 500 || /[\r\n\0]/.test(raw.start)) throw new Error("Cookbook needs one start command.");
  const healthPath = raw.healthPath ?? "/";
  if (typeof healthPath !== "string" || !healthPath.startsWith("/") || healthPath.startsWith("//") || healthPath.includes("\\") || healthPath.length > 200 || new URL(healthPath, "http://127.0.0.1").origin !== "http://127.0.0.1") throw new Error("Health path must be a local URL path.");
  return { version: 1, workingDir, setup, build, start: raw.start,
    healthPath, variables: stringRecord(raw.variables ?? {}, "variables"), secrets: stringRecord(raw.secrets ?? {}, "secrets") };
}

export async function readCookbook(repo: string): Promise<Cookbook | undefined> {
  try { return parseCookbook(JSON.parse(await readFile(cookbookPath(repo), "utf8")) as unknown); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}

export async function saveCookbook(repo: string, value: unknown): Promise<Cookbook> {
  const book = parseCookbook(value);
  const destination = cookbookPath(repo);
  await mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(book, null, 2) + "\n", "utf8");
  await rename(temp, destination);
  return book;
}

export function commandKey(command: string): string { return createHash("sha256").update(command).digest("hex").slice(0, 20); }

export async function commandRisk(command: string, workingDir: string): Promise<string | undefined> {
  const suspicious = /\b(?:sudo|runas|format|diskpart|reg\s+(?:delete|add)|git\s+(?:push|clean|reset\s+--hard)|rm\s+-[a-z]*[rf]|Remove-Item|del\s+\/|curl\b.*\|\s*(?:bash|sh)|Invoke-Expression|iwr\b.*\|\s*iex|powershell(?:\.exe)?\s+-command|node\s+-e|python\s+-c)\b/i;
  if (suspicious.test(command)) return "This command may change files outside the preview or execute downloaded code.";
  const npm = /^(?:npm|npm\.cmd|pnpm|yarn)\s+(?:(?:run\s+)?([\w:-]+))/i.exec(command.trim());
  if (npm) {
    try {
      const pkg = JSON.parse(await readFile(path.join(workingDir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      const script = pkg.scripts?.[npm[1]];
      if (!script && !["ci", "install", "add", "exec", "dlx"].includes(npm[1])) return "The referenced package script could not be inspected.";
      if (script && suspicious.test(script)) return `The package script '${npm[1]}' may change files outside the preview.`;
    } catch { return "The referenced package script could not be inspected."; }
  }
  if (/\b(?:npm|pnpm|yarn|pip)\s+(?:install|add)\b/i.test(command) && !/\bnpm\s+ci\s+--ignore-scripts\b/i.test(command)) return "Dependency installation may execute package scripts.";
  return undefined;
}

export function extractCookbook(text: string): Cookbook {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return parseCookbook(JSON.parse(cleaned) as unknown);
}
