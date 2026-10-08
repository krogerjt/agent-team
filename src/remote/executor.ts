import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { git } from "../coding/git.js";
import type { CheckArtifact, CheckCommand, CheckResult, CheckRunContext } from "../coding/checks.js";
import { selectSimulatorDestination } from "../coding/apple.js";
import { readRemoteBuildHost, readRemoteProjectSettings, validateRemoteBuildHost, type RemoteBuildHost } from "./settings.js";
import { buildKeychainShell, keychainHealthScript, keychainRedactionScript, keychainSecretLookup, keychainSecretStore } from "./keychain.js";

export interface RemoteReadinessItem { name: string; ok: boolean; detail: string }
export interface RemoteReadiness { ok: boolean; target: string; items: RemoteReadinessItem[] }

const LIMIT = 12_000;

export function quote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }
function sshArgs(host: RemoteBuildHost, remoteArgs: string[]): string[] {
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...(host.port ? ["-p", String(host.port)] : []), host.target, ...remoteArgs];
}

function capture(executable: string, args: string[], input = "", timeoutMs = 30_000, maxOutput = LIMIT): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", ended = false;
    const append = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-maxOutput); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (error) => { if (!ended) { ended = true; clearTimeout(timer); resolve({ code: -1, output: error.message }); } });
    child.on("close", (code, signal) => { if (!ended) { ended = true; clearTimeout(timer); resolve({ code: code ?? -1, output: signal ? `Terminated (${signal}).\n${output}` : output }); } });
    child.stdin.end(input);
  });
}

export async function sshScript(host: RemoteBuildHost, script: string, timeoutMs = 30_000, maxOutput = LIMIT): Promise<{ code: number; output: string }> {
  return capture("ssh", sshArgs(host, ["/bin/zsh", "-s"]), `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"\n${script}`, timeoutMs, maxOutput);
}

export function remotePaths(host: RemoteBuildHost, id: string): { root: string; job: string; source: string; cache: string } {
  const root = `"$HOME"/${quote(host.root)}`;
  return { root, job: `${root}/jobs/${id}`, source: `${root}/jobs/${id}/source`, cache: `${root}/cache` };
}

export type RemoteScriptRunner = (host: RemoteBuildHost, script: string, timeoutMs?: number, maxOutput?: number) => Promise<{ code: number; output: string }>;

export async function testRemoteBuildHost(host: RemoteBuildHost, setupCommand = "", run: RemoteScriptRunner = sshScript, requiredTools: string[] = []): Promise<RemoteReadiness> {
  host = validateRemoteBuildHost(host);
  const items: RemoteReadinessItem[] = [];
  if (!host.target) return { ok: false, target: "", items: [{ name: "SSH target", ok: false, detail: "Enter a Mac SSH alias or user@host." }] };
  const keychain = await run(host, `${keychainHealthScript()}
`, 20_000);
  const result = await run(host, `
set +e
printf 'MACOS\t'; sw_vers -productVersion 2>/dev/null || true
printf 'XCODE\t'; xcodebuild -version 2>/dev/null | head -1 || true
printf 'SIMULATORS\t'; xcrun simctl list devices available 2>/dev/null | grep -Ec 'iPhone|iPad|Apple TV|Apple Watch|Vision Pro' || true
printf 'TAR\t'; command -v tar 2>/dev/null || true
printf '\nXCODEGEN\t'; command -v xcodegen 2>/dev/null || true
printf '\nPOD\t'; command -v pod 2>/dev/null || true
printf 'BUNDLE\t'; command -v bundle 2>/dev/null || true
printf '\nDISK\t'; df -Pk "$HOME" 2>/dev/null | tail -1 | awk '{print $4}'
`, 20_000);
  if (keychain.code !== 0) return { ok: false, target: host.target, items: [{ name: "SSH connection", ok: true, detail: host.target }, { name: "Agent Team Build Keychain", ok: false, detail: keychain.output.trim() || "The dedicated build Keychain could not be unlocked or read." }] };
  if (result.code !== 0) return { ok: false, target: host.target, items: [{ name: "SSH connection", ok: false, detail: result.output.trim() || `ssh exited ${result.code}` }] };
  const values = Object.fromEntries(result.output.split(/\r?\n/).map((line) => line.split("\t", 2)).filter((parts) => parts.length === 2));
  items.push({ name: "SSH connection", ok: true, detail: host.target });
  items.push({ name: "macOS", ok: Boolean(values.MACOS), detail: values.MACOS || "sw_vers was unavailable" });
  items.push({ name: "Full Xcode", ok: /^Xcode /.test(values.XCODE ?? ""), detail: values.XCODE || "Install and initialize full Xcode" });
  items.push({ name: "Simulator", ok: Number(values.SIMULATORS) > 0, detail: Number(values.SIMULATORS) > 0 ? `${values.SIMULATORS} available devices` : "Install an Apple simulator runtime" });
  items.push({ name: "Archive tool", ok: Boolean(values.TAR), detail: values.TAR || "tar was not found" });
  if (requiredTools.includes("xcodegen")) items.push({ name: "XcodeGen", ok: Boolean(values.XCODEGEN), detail: values.XCODEGEN || "Install XcodeGen on the Mac (brew install xcodegen) and make it available to SSH builds." });
  items.push({ name: "Agent Team Build Keychain", ok: true, detail: "Exists, unlocked, and readable" });
  if (/\bpod(?:\s|$)/.test(setupCommand)) items.push({ name: "CocoaPods", ok: Boolean(values.POD), detail: values.POD || "Install CocoaPods on the Mac" });
  if (/\bbundle(?:\s|$)/.test(setupCommand)) items.push({ name: "Bundler", ok: Boolean(values.BUNDLE), detail: values.BUNDLE || "Install Bundler on the Mac" });
  const freeKb = Number(values.DISK ?? 0);
  items.push({ name: "Free space", ok: freeKb >= 10 * 1024 * 1024, detail: freeKb ? `${Math.floor(freeKb / 1024 / 1024)} GB available` : "Could not read free space" });
  return { ok: items.every((item) => item.ok), target: host.target, items };
}

export async function saveRemoteKeychainSecret(host: RemoteBuildHost, name: string, value: string): Promise<void> {
  host = validateRemoteBuildHost(host);
  if (!/^[A-Za-z][A-Za-z0-9_.:/-]{0,99}$/.test(name) || !value || value.length > 8_000) throw new Error("Invalid remote secret name or value.");
  const result = await sshScript(host, `${buildKeychainShell()}\n${keychainSecretStore(name, value)}\n`);
  if (result.code !== 0) throw new Error(`Could not save the Mac Build Keychain secret '${name}'. ${result.output.trim()}`.trim());
}

export async function upload(root: string, host: RemoteBuildHost, remoteSource: string): Promise<void> {
  const names = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (!names) throw new Error("The worktree has no files to upload.");
  await new Promise<void>((resolve, reject) => {
    const pack = spawn("tar", ["-cf", "-", "--null", "-T", "-"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const unpack = spawn("ssh", sshArgs(host, [`mkdir -p ${remoteSource} && tar -xf - -C ${remoteSource}`]), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let error = "", packCode: number | null = null, unpackCode: number | null = null;
    const finish = () => {
      if (packCode === null || unpackCode === null) return;
      packCode === 0 && unpackCode === 0 ? resolve() : reject(new Error(`Remote upload failed: ${error.slice(-2_000)}`));
    };
    pack.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    unpack.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    pack.on("error", reject); unpack.on("error", reject);
    pack.on("close", (code) => { packCode = code; finish(); });
    unpack.on("close", (code) => { unpackCode = code; finish(); });
    pack.stdout.pipe(unpack.stdin); pack.stdin.end(names);
  });
}

export async function collectFiles(folder: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(next); else found.push(next);
    }
  }
  try { await visit(folder); } catch { /* no attachments */ }
  return found;
}

export async function downloadAttachments(host: RemoteBuildHost, remoteFolder: string, localFolder: string): Promise<void> {
  await mkdir(localFolder, { recursive: true });
  await new Promise<void>((resolve) => {
    const remote = spawn("ssh", sshArgs(host, [`cd ${remoteFolder} 2>/dev/null && { count=0; total=0; find . -type f \\( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \\) -size -10M -print0 | while IFS= read -r -d '' file; do size=$(stat -f %z "$file" 2>/dev/null || printf 0); [ $((total+size)) -gt 10485760 ] && continue; printf '%s\\0' "$file"; total=$((total+size)); count=$((count+1)); [ "$count" -ge 20 ] && break; done; } | tar -cf - --null -T -`]), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const local = spawn("tar", ["-xf", "-", "-C", localFolder], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    remote.stdout.pipe(local.stdin);
    let remoteDone = false, localDone = false;
    const done = () => { if (remoteDone && localDone) resolve(); };
    remote.on("error", () => { remoteDone = true; done(); }); local.on("error", () => { localDone = true; done(); });
    remote.on("close", () => { remoteDone = true; done(); }); local.on("close", () => { localDone = true; done(); });
  });
}

export async function runRemoteChecks(root: string, commands: CheckCommand[], context?: CheckRunContext): Promise<CheckResult[]> {
  const host = await readRemoteBuildHost();
  if (!host.enabled || !host.target) return commands.map((command) => ({ name: command.name, status: "missing", required: true, output: "Configure and enable a Mac Build Host in Workshop Options." }));
  const project = await readRemoteProjectSettings(context?.repo ?? root);
  const ready = await testRemoteBuildHost(host, project.setupCommand, undefined, commands.map((command) => command.executable));
  if (!ready.ok) return commands.map((command) => ({ name: command.name, status: "missing", required: true, executor: host.target, output: `Mac Build Host is not ready: ${ready.items.filter((item) => !item.ok).map((item) => `${item.name}: ${item.detail}`).join("; ")}` }));
  const id = randomUUID().replaceAll("-", "");
  const paths = remotePaths(host, id);
  const init = await sshScript(host, `set -e\nmkdir -p ${paths.source} ${paths.cache}\n`);
  if (init.code !== 0) return commands.map((command) => ({ name: command.name, status: "failed", required: true, executor: host.target, output: init.output }));
  const results: CheckResult[] = [];
  try {
    await upload(root, host, paths.source);
    if (project.setupCommand) {
      const setup = await sshScript(host, `set -e\ncd ${paths.source}\n${project.setupCommand}\n`, 600_000);
      if (setup.code !== 0) return commands.map((command) => ({ name: command.name, status: "failed", required: true, executor: host.target, output: `Remote preparation failed:\n${setup.output}` }));
    }
    const secretEntries = Object.entries(project.secrets);
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index];
      let args = [...command.args];
      if (command.simulatorPlatform) {
        const devices = await sshScript(host, "xcrun simctl list devices available --json\n", 30_000, 4_000_000);
        const destination = devices.code === 0 ? selectSimulatorDestination(devices.output, command.simulatorPlatform) : undefined;
        if (!destination) { results.push({ name: command.name, status: "missing", required: true, executor: host.target, output: `No available ${command.simulatorPlatform} simulator was found on ${host.target}.` }); continue; }
        args = args.map((arg) => arg === "{available-simulator}" ? destination : arg);
      }
      const isTest = args.includes("test");
      const remoteResult = `${paths.job}/result-${index}.xcresult`;
      let buildPaths = "";
      if (command.executable === "xcodebuild") {
        // These paths are shell expressions rooted in the remote HOME, not literal argv strings.
        buildPaths = ` -derivedDataPath ${paths.cache}/DerivedData${isTest ? ` -resultBundlePath ${remoteResult}` : ""}`;
      }
      const exports = secretEntries.map(([variable, name]) => `export ${variable}="$(${keychainSecretLookup(name)})" || { printf '%s\\n' ${quote(`Mac Build Keychain secret '${name}' is unavailable.`)} >&2; exit 23; }`).join("\n");
      const redactions = secretEntries.map(([variable]) => keychainRedactionScript(variable)).join(" | ");
      const script = `${buildKeychainShell()}\nset -o pipefail\n${exports}\ncd ${paths.source}\noutput=$(mktemp)\ntrap 'rm -f "$output"' EXIT\nset +e\n${quote(command.executable)} ${args.map(quote).join(" ")}${buildPaths} >"$output" 2>&1\ncode=$?\nset -e\n${redactions ? `${redactions} "$output"` : `cat "$output"`}\nif [ "$code" -ne 0 ]; then\n  printf '\\nBuild diagnostics:\\n'\n  { grep -E 'error:|fatal error:|BUILD FAILED' "$output" | tail -40 || true; }${redactions ? ` | ${redactions}` : ""}\nfi\nprintf '\\n'\nexit "$code"\n`;
      const execution = await sshScript(host, script, command.timeoutMs ?? 600_000);
      const result: CheckResult = { name: command.name, status: execution.code === 0 ? "passed" : "failed", required: true, executor: host.target, output: execution.output.slice(-LIMIT) };
      if (isTest) {
        const summary = await sshScript(host, `xcrun xcresulttool get test-results summary --path ${remoteResult} --compact 2>/dev/null || true\n`, 30_000, 100_000);
        if (summary.output.trim()) {
          result.summary = summary.output.trim().slice(0, 20_000);
          if (context?.runDir) {
            const folder = path.join(context.runDir, "check-artifacts", `${context.taskId ?? "check"}-${Date.now()}-${index}`);
            await mkdir(folder, { recursive: true });
            const summaryFile = path.join(folder, "summary.json");
            await writeFile(summaryFile, result.summary, "utf8");
            result.artifacts = [{ name: "XCTest summary", path: path.relative(context.runDir, summaryFile).replaceAll("\\", "/"), mimeType: "application/json" }];
            await sshScript(host, `rm -rf ${paths.job}/attachments-${index}; mkdir -p ${paths.job}/attachments-${index}; xcrun xcresulttool export attachments --path ${remoteResult} --output-path ${paths.job}/attachments-${index} >/dev/null 2>&1 || true\n`);
            const localAttachments = path.join(folder, "attachments");
            await downloadAttachments(host, `${paths.job}/attachments-${index}`, localAttachments);
            const images = (await collectFiles(localAttachments)).slice(0, 20);
            result.artifacts.push(...images.map((file): CheckArtifact => ({ name: path.basename(file), path: path.relative(context.runDir!, file).replaceAll("\\", "/"), mimeType: /\.png$/i.test(file) ? "image/png" : "image/jpeg" })));
          }
        }
      }
      results.push(result);
      if (command.executable === "xcodegen" && result.status !== "passed") break;
    }
  } catch (error) {
    return commands.map((command) => ({ name: command.name, status: "failed", required: true, executor: host.target, output: error instanceof Error ? error.message : String(error) }));
  } finally {
    await sshScript(host, `rm -rf ${paths.job}\n`).catch(() => undefined);
  }
  return results;
}
