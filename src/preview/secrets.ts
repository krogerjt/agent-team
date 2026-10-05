import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const vaultPath = () => path.join(process.env.AGENT_TEAM_DATA_DIR ? path.resolve(process.env.AGENT_TEAM_DATA_DIR) : path.join(os.homedir(), ".agent-team"), "preview-secrets.json");
const namePattern = /^[A-Za-z][A-Za-z0-9_.:/-]{0,99}$/;

function transform(value: string, mode: "Protect" | "Unprotect"): Promise<string> {
  if (process.platform !== "win32") throw new Error("Persistent preview secrets currently require Windows user encryption.");
  const script = `Add-Type -AssemblyName System.Security;$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::${mode}($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`Secret encryption failed: ${err.slice(0, 300)}`)));
    child.stdin.end(mode === "Protect" ? Buffer.from(value, "utf8").toString("base64") : value);
  });
}

async function readVault(): Promise<Record<string, string>> {
  try { return JSON.parse(await readFile(vaultPath(), "utf8")) as Record<string, string>; }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {}; throw error; }
}

export async function listSecrets(): Promise<string[]> { return Object.keys(await readVault()).sort(); }
export async function setSecret(name: string, value: string): Promise<void> {
  if (!namePattern.test(name) || !value || value.length > 20_000) throw new Error("Invalid secret name or value.");
  const vault = await readVault();
  vault[name] = await transform(value, "Protect");
  const destination = vaultPath();
  await mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(vault, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(temp, destination);
}
export async function getSecret(name: string): Promise<string | undefined> {
  const encrypted = (await readVault())[name];
  if (!encrypted) return undefined;
  return Buffer.from(await transform(encrypted, "Unprotect"), "base64").toString("utf8");
}
