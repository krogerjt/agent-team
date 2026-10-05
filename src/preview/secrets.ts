import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const vaultPath = () => path.join(process.env.AGENT_TEAM_DATA_DIR ? path.resolve(process.env.AGENT_TEAM_DATA_DIR) : path.join(os.homedir(), ".agent-team"), "preview-secrets.json");
const namePattern = /^[A-Za-z][A-Za-z0-9_.:/-]{0,99}$/;
const keychainService = "com.openai.agent-team.preview-secret";

function run(executable: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(Object.assign(new Error(`${path.basename(executable)} failed: ${err.slice(0, 300)}`), { code })));
    child.stdin.end(input);
  });
}

async function transform(value: string, mode: "Protect" | "Unprotect"): Promise<string> {
  if (process.platform !== "win32") throw new Error("DPAPI secret storage requires Windows.");
  const script = `Add-Type -AssemblyName System.Security;$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::${mode}($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  return (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], mode === "Protect" ? Buffer.from(value, "utf8").toString("base64") : value)).trim();
}

async function readVault(): Promise<Record<string, string>> {
  try { return JSON.parse(await readFile(vaultPath(), "utf8")) as Record<string, string>; }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {}; throw error; }
}

export async function listSecrets(): Promise<string[]> { return Object.keys(await readVault()).sort(); }
export async function setSecret(name: string, value: string): Promise<void> {
  if (!namePattern.test(name) || !value || value.length > 20_000) throw new Error("Invalid secret name or value.");
  const vault = await readVault();
  if (process.platform === "win32") vault[name] = await transform(value, "Protect");
  else if (process.platform === "darwin") {
    await run("/usr/bin/security", ["add-generic-password", "-U", "-a", name, "-s", keychainService, "-w", value]);
    vault[name] = "keychain";
  } else throw new Error("Persistent preview secrets are supported on Windows and macOS.");
  const destination = vaultPath();
  await mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(vault, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(temp, destination);
}
export async function getSecret(name: string): Promise<string | undefined> {
  const encrypted = (await readVault())[name];
  if (!encrypted) return undefined;
  if (process.platform === "win32") return Buffer.from(await transform(encrypted, "Unprotect"), "base64").toString("utf8");
  if (process.platform === "darwin") {
    try {
      const output = await run("/usr/bin/security", ["find-generic-password", "-w", "-a", name, "-s", keychainService]);
      return output.endsWith("\n") ? output.slice(0, -1).replace(/\r$/, "") : output;
    }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === 44) return undefined; throw error; }
  }
  throw new Error("Persistent preview secrets are supported on Windows and macOS.");
}
