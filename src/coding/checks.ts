import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { git } from "./git.js";
import { runRemoteChecks } from "../remote/executor.js";
import { selectSimulatorDestination } from "./apple.js";
export { selectSimulatorDestination } from "./apple.js";

const execFileAsync = promisify(execFile);

export type CheckStatus = "passed" | "failed" | "missing";
export interface CheckArtifact { name: string; path: string; mimeType: string }
export interface CheckResult {
  name: string;
  status: CheckStatus;
  output: string;
  required?: boolean;
  executor?: string;
  summary?: string;
  artifacts?: CheckArtifact[];
}

export interface CheckRunContext { repo?: string; runDir?: string; taskId?: string }

export interface CheckCommand {
  name: string;
  executable: string;
  args: string[];
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  simulatorPlatform?: string;
}

export function checkEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { CI: "1" };
  for (const [name, value] of Object.entries(source)) {
    if (!/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/i.test(name)) environment[name] = value;
  }
  return environment;
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
  commands.push(...await detectXcodeChecks(root));
  return commands;
}

function xcodeContainer(files: string[]): { flag: "-workspace" | "-project"; file: string } | undefined {
  const workspaces = files.filter((file) => /\.xcworkspace\/contents\.xcworkspacedata$/.test(file) && !/\.xcodeproj\/project\.xcworkspace\//.test(file)).map((file) => file.replace(/\/contents\.xcworkspacedata$/, ""));
  const projects = files.filter((file) => /\.xcodeproj\/project\.pbxproj$/.test(file)).map((file) => file.replace(/\/project\.pbxproj$/, ""));
  const uniqueWorkspaces = [...new Set(workspaces)];
  const uniqueProjects = [...new Set(projects)];
  if (uniqueWorkspaces.length === 1) return { flag: "-workspace", file: uniqueWorkspaces[0] };
  if (uniqueWorkspaces.length === 0 && uniqueProjects.length === 1) return { flag: "-project", file: uniqueProjects[0] };
  return undefined;
}

async function detectXcodeChecks(root: string): Promise<CheckCommand[]> {
  const files = (await git(root, ["ls-files"])).split(/\r?\n/).filter(Boolean);
  const container = xcodeContainer(files);
  if (!container) return [];
  const sharedSchemes = files.filter((file) => /xcshareddata\/xcschemes\/[^/]+\.xcscheme$/.test(file));
  let schemes = [...new Set(sharedSchemes.map((file) => path.basename(file, ".xcscheme")))];
  if (schemes.length === 0) schemes = [path.basename(container.file).replace(/\.(?:xcworkspace|xcodeproj)$/, "")];

  const projectFiles = files.filter((file) => /\.xcodeproj\/project\.pbxproj$/.test(file));
  const projectText = (await Promise.all(projectFiles.map((file) => readFile(path.join(root, file), "utf8")))).join("\n");
  const sdk = /SDKROOT\s*=\s*iphoneos/.test(projectText) ? "iOS Simulator" : /SDKROOT\s*=\s*appletvos/.test(projectText) ? "tvOS Simulator" : /SDKROOT\s*=\s*watchos/.test(projectText) ? "watchOS Simulator" : /SDKROOT\s*=\s*xros/.test(projectText) ? "visionOS Simulator" : /SDKROOT\s*=\s*macosx/.test(projectText) ? "macOS" : "iOS Simulator";

  const commands: CheckCommand[] = [];
  for (const scheme of schemes) {
    const base = [container.flag, container.file, "-scheme", scheme];
    commands.push({
      name: `xcodebuild ${scheme} (${sdk})`, executable: "xcodebuild",
      args: [...base, "-destination", `generic/platform=${sdk}`, "build", "CODE_SIGNING_ALLOWED=NO"],
      platform: "darwin", timeoutMs: 600_000,
    });
    const schemeFiles = sharedSchemes.filter((file) => path.basename(file, ".xcscheme") === scheme);
    const schemeText = (await Promise.all(schemeFiles.map((file) => readFile(path.join(root, file), "utf8")))).join("\n");
    if (sdk.endsWith("Simulator") && /<TestableReference\b/.test(schemeText)) commands.push({
      name: `xcodebuild ${scheme} tests (${sdk})`, executable: "xcodebuild",
      args: [...base, "-destination", "{available-simulator}", "test", "CODE_SIGNING_ALLOWED=NO"],
      platform: "darwin", timeoutMs: 600_000, simulatorPlatform: sdk.replace(/ Simulator$/, ""),
    });
  }
  return commands;
}

export async function executeCheck(root: string, command: CheckCommand, timeoutMs = command.timeoutMs ?? 120_000): Promise<CheckResult> {
  if (command.platform && command.platform !== process.platform) {
    return { name: command.name, status: "missing", output: `This check requires ${command.platform === "darwin" ? "macOS with full Xcode installed" : command.platform}; the current host is ${process.platform}.` };
  }
  let commandArgs = command.args;
  if (command.simulatorPlatform) {
    try {
      const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "available", "--json"], { cwd: root, maxBuffer: 4_000_000 });
      const destination = selectSimulatorDestination(stdout, command.simulatorPlatform);
      if (!destination) return { name: command.name, status: "missing", output: `No available ${command.simulatorPlatform} simulator was found.` };
      commandArgs = command.args.map((arg) => arg === "{available-simulator}" ? destination : arg);
    } catch (error) {
      return { name: command.name, status: "missing", output: `Could not inspect installed simulators: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return new Promise((resolve) => {
    const windowsNpm = process.platform === "win32" && command.executable === "npm";
    const executable = windowsNpm ? "cmd.exe" : command.executable;
    const args = windowsNpm ? ["/d", "/s", "/c", `npm.cmd ${commandArgs.join(" ")}`] : commandArgs;
    const child = spawn(executable, args, {
      cwd: root,
      windowsHide: true,
      env: checkEnvironment(process.env),
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

export async function runChecks(root: string, context?: CheckRunContext): Promise<CheckResult[]> {
  const commands = await detectChecks(root);
  if (commands.length === 0) return [{ name: "automatic checks", status: "missing", output: "No supported checks detected." }];
  const results: CheckResult[] = [];
  let runnable = commands;
  if (runnable.some((command) => command.executable === "npm") && !await exists(path.join(root, "node_modules"))) {
    if (!await exists(path.join(root, "package-lock.json"))) {
      results.push({ name: "npm dependencies", status: "missing", output: "node_modules and package-lock.json are absent; cannot install deterministically." });
      runnable = runnable.filter((command) => command.executable !== "npm");
    } else {
      const install = await executeCheck(root, { name: "npm ci --ignore-scripts", executable: "npm", args: ["ci", "--ignore-scripts"] });
      if (install.status !== "passed") {
        results.push(install);
        runnable = runnable.filter((command) => command.executable !== "npm");
      }
    }
  }
  const remote = runnable.filter((command) => command.platform && command.platform !== process.platform);
  runnable = runnable.filter((command) => !remote.includes(command));
  for (const command of runnable) results.push(await executeCheck(root, command));
  if (remote.length) results.push(...await runRemoteChecks(root, remote, context));
  return results;
}
