import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { git } from "./git.js";

export type CheckStatus = "passed" | "failed" | "missing";
export interface CheckResult {
  name: string;
  status: CheckStatus;
  output: string;
}

interface CheckCommand {
  name: string;
  executable: string;
  args: string[];
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

export async function detectChecks(root: string): Promise<CheckCommand[]> {
  const commands: CheckCommand[] = [];
  const entries = await readdir(root);
  if (entries.includes("package.json")) {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    if (pkg.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) {
      commands.push({ name: "npm test", executable: "npm", args: ["test"] });
    }
    if (pkg.scripts?.typecheck) commands.push({ name: "npm run typecheck", executable: "npm", args: ["run", "typecheck"] });
  }
  const solutions = entries.filter((name) => /\.slnx?$/.test(name));
  if (solutions.length === 1) commands.push({ name: "dotnet test", executable: "dotnet", args: ["test", solutions[0], "--nologo"] });
  else if (solutions.length === 0) {
    const projects = (await git(root, ["ls-files", "--", "*.csproj"])).split(/\r?\n/).filter(Boolean);
    if (projects.length === 1) commands.push({ name: "dotnet test", executable: "dotnet", args: ["test", projects[0], "--nologo"] });
  }
  const pyproject = entries.includes("pyproject.toml") ? await readFile(path.join(root, "pyproject.toml"), "utf8") : "";
  const hasPython = entries.includes("pyproject.toml") || entries.includes("setup.py") || entries.includes("requirements.txt") || entries.includes("pytest.ini");
  if (hasPython) {
    const pytest = entries.includes("pytest.ini") || entries.includes("conftest.py") || /\[tool\.pytest/.test(pyproject) || /\bpytest\b/.test(pyproject);
    commands.push(pytest
      ? { name: "python -m pytest", executable: "python", args: ["-m", "pytest"] }
      : { name: "python -m unittest discover", executable: "python", args: ["-m", "unittest", "discover"] });
  }
  return commands;
}

export async function executeCheck(root: string, command: CheckCommand, timeoutMs = 120_000): Promise<CheckResult> {
  return new Promise((resolve) => {
    const windowsNpm = process.platform === "win32" && command.executable === "npm";
    const executable = windowsNpm ? "cmd.exe" : command.executable;
    const args = windowsNpm ? ["/d", "/s", "/c", `npm.cmd ${command.args.join(" ")}`] : command.args;
    const child = spawn(executable, args, {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, CI: "1" },
    });
    let output = "";
    let ended = false;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const append = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-8_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      resolve({ name: command.name, status: error.code === "ENOENT" ? "missing" : "failed", output: error.message });
    });
    child.on("close", (code, signal) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      resolve({ name: command.name, status: code === 0 ? "passed" : "failed", output: signal ? `Terminated (${signal}).\n${output}` : output });
    });
  });
}

export async function runChecks(root: string): Promise<CheckResult[]> {
  const commands = await detectChecks(root);
  if (commands.length === 0) return [{ name: "automatic checks", status: "missing", output: "No supported checks detected." }];
  if (commands.some((command) => command.executable === "npm") && !await exists(path.join(root, "node_modules"))) {
    if (!await exists(path.join(root, "package-lock.json"))) {
      return [{ name: "npm dependencies", status: "missing", output: "node_modules and package-lock.json are absent; cannot install deterministically." }];
    }
    const install = await executeCheck(root, { name: "npm ci --ignore-scripts", executable: "npm", args: ["ci", "--ignore-scripts"] });
    if (install.status !== "passed") return [install];
  }
  const results: CheckResult[] = [];
  for (const command of commands) results.push(await executeCheck(root, command));
  return results;
}
