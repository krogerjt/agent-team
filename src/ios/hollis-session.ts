import path from "node:path";
import { createBranchWorktree, git } from "../coding/git.js";
import type { ToolDefinition, ToolResult } from "../core/provider.js";
import { WorkspaceTools } from "../coding/workspace-tools.js";
import { createWebExecutor, isWebTool, webTools, type WebDeps } from "../team/web-tools.js";
import type { RemoteScriptRunner } from "../remote/executor.js";
import { executeIosTool, iosTools, isIosTool, type IosToolContext } from "./tools.js";

const schema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

const workspaceTool: ToolDefinition = {
  name: "ios_open_release_workspace",
  description: "Open a separate Git worktree (new branch from the current commit) where you may edit project files, tests, release metadata and docs. The user's own checkout is never edited. Uncommitted changes in the user's checkout are NOT included. Required before apply_patch or create_png work. Safe to call again: it returns the open workspace.",
  parameters: schema({}),
};
const commitTool: ToolDefinition = {
  name: "ios_commit_release_changes",
  description: "Commit everything in the open release workspace to its branch (local only: never pushes or merges; the user reviews and merges). Refuses files that look like credentials.",
  parameters: schema({ message: { type: "string", description: "Commit message, up to 200 characters." } }, ["message"]),
};

export const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.(p8|p12|pfx|pem|key|mobileprovision|keychain|keychain-db|cer)|AuthKey_[A-Z0-9]+\.p8|mac-build-host\.env)$/i;

export interface HollisSessionOptions {
  repo: string;
  /** Where to start: the user's checkout (read-only), or an existing staging/task worktree (writable). */
  root: string;
  writable: boolean;
  runDir?: string;
  web?: WebDeps;
  run?: RemoteScriptRunner;
  /** Test seam. */
  openWorktree?: (repo: string, branch: string) => Promise<{ path: string; branch: string }>;
}

export interface HollisSession {
  definitions: ToolDefinition[];
  root(): string;
  writable(): boolean;
  /** Returns undefined when the tool is not one of Hollis's. */
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult | undefined>;
}

const GATED = new Set(["apply_patch", "create_png"]);

export function createHollisSession(options: HollisSessionOptions): HollisSession {
  let root = options.root;
  let writable = options.writable;
  let workspace = new WorkspaceTools(root, writable ? "lead" : "researcher");
  const web = createWebExecutor(options.web);
  // Stable tool list for the model: patch tools are always listed, and refuse until a writable workspace exists.
  const files = new WorkspaceTools(root, "lead").definitions.filter((definition) => definition.name !== "generate_png");
  const definitions = [...iosTools(), workspaceTool, commitTool, ...files, ...webTools];
  const context = (): IosToolContext => ({ root, repo: options.repo, writable, runDir: options.runDir, run: options.run });

  async function openWorkspace(): Promise<ToolResult> {
    if (writable) return { content: JSON.stringify({ workspace: root, note: "A writable workspace is already open.", branch: await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => undefined) }) };
    const dirty = (await git(options.repo, ["status", "--porcelain", "--untracked-files=all"]).catch(() => "")).split("\n").filter(Boolean).length;
    const branch = `codex/hollis-release-${Date.now().toString(36)}`;
    const opened = await (options.openWorktree ?? ((repo, name) => createBranchWorktree(repo, name, "HEAD")))(options.repo, branch);
    root = opened.path; writable = true; workspace = new WorkspaceTools(root, "lead");
    return { content: JSON.stringify({ workspace: opened.path, branch: opened.branch, note: dirty ? `${dirty} uncommitted change(s) in the user's checkout are NOT in this workspace. Ask the user to commit them first if you need them.` : "Opened from the current commit. Edit here, commit with ios_commit_release_changes, and ask the user to review and merge." }) };
  }

  async function commit(args: Record<string, unknown>): Promise<ToolResult> {
    if (!writable || path.resolve(root) === path.resolve(options.repo)) return { content: "Open a release workspace first (ios_open_release_workspace). I never commit in the user's own checkout.", isError: true };
    const message = typeof args.message === "string" ? args.message.trim() : "";
    if (!message || message.length > 200 || /[\r\n]/.test(message)) return { content: "Give a one-line commit message of 1 to 200 characters.", isError: true };
    await git(root, ["add", "-A"]);
    const staged = (await git(root, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
    if (!staged.length) return { content: JSON.stringify({ committed: false, note: "Nothing to commit." }) };
    const risky = staged.filter((file) => SECRET_FILE.test(file));
    if (risky.length) { await git(root, ["reset", "-q"]); return { content: `Refusing to commit files that look like credentials: ${risky.join(", ")}. Remove them (never commit keys, certificates, profiles or .env files).`, isError: true }; }
    await git(root, ["-c", "user.name=Agent Team Hollis", "-c", "user.email=agent-team@localhost.invalid", "commit", "-q", "-m", message]);
    return { content: JSON.stringify({ committed: true, files: staged.length, commit: await git(root, ["rev-parse", "--short", "HEAD"]), branch: await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]), note: "Committed locally only. The user reviews and merges; nothing was pushed." }) };
  }

  return {
    definitions, root: () => root, writable: () => writable,
    async execute(name, args) {
      if (isWebTool(name)) return web(name, args);
      if (name === "ios_open_release_workspace") return openWorkspace();
      if (name === "ios_commit_release_changes") return commit(args);
      if (isIosTool(name)) return executeIosTool(name, args, context());
      if (GATED.has(name) && !writable) return { content: "No writable workspace is open. Call ios_open_release_workspace first; edits never go into the user's own checkout.", isError: true };
      if (definitions.some((definition) => definition.name === name)) return workspace.execute(name, args);
      return undefined;
    },
  };
}
