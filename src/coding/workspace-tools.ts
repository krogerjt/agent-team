import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { git } from "./git.js";
import type { ToolDefinition, ToolResult } from "../core/provider.js";

export type ToolMode = "researcher" | "lead";
const FILE_LIMIT = 20_000;
const SEARCH_BYTES = 5_000_000;
const execFileAsync = promisify(execFile);

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const readTools: ToolDefinition[] = [
  { name: "list_files", description: "List tracked and non-ignored files in the repository. Results are capped.", parameters: schema({}, []) },
  { name: "read_file", description: "Read one UTF-8 text file in the repository, using a relative path.", parameters: schema({ path: { type: "string" } }, ["path"]) },
  { name: "search", description: "Search repository text files for a literal substring.", parameters: schema({ query: { type: "string" } }, ["query"]) },
];

const patchTool: ToolDefinition = {
  name: "apply_patch",
  description: "Change one file. For an existing file, oldText must be a unique exact substring and newText replaces it. To create a new file, use oldText='' and newText as the complete contents. All paths are relative to the repository.",
  parameters: schema({ path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, ["path", "oldText", "newText"]),
};

function stringArg(args: Record<string, unknown>, name: string): string {
  if (typeof args[name] !== "string") throw new Error(`${name} must be a string.`);
  return args[name];
}

export class WorkspaceTools {
  readonly definitions: ToolDefinition[];
  private readonly created = new Set<string>();

  constructor(private readonly root: string, private readonly mode: ToolMode) {
    this.definitions = mode === "lead" ? [...readTools, patchTool] : [...readTools];
  }

  private async fileList(): Promise<string[]> {
    const output = await git(this.root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    return output.split("\0").filter(Boolean).map((item) => item.replaceAll("\\", "/"));
  }

  private async safePath(relative: string): Promise<{ absolute: string; normalized: string }> {
    if (!relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) throw new Error("Use a relative repository path.");
    const normalized = relative.replaceAll("\\", "/");
    const segments = normalized.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".git")) {
      throw new Error("Path is outside the allowed repository files.");
    }
    const absolute = path.resolve(this.root, ...segments);
    const prefix = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (!absolute.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error("Path escapes the worktree.");
    let cursor = this.root;
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      try {
        if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Symbolic links are not accessible.");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") break;
        throw error;
      }
    }
    return { absolute, normalized };
  }

  private async allowed(relative: string): Promise<{ absolute: string; normalized: string }> {
    const target = await this.safePath(relative);
    const files = await this.fileList();
    if (!files.includes(target.normalized) && !this.created.has(target.normalized)) {
      throw new Error("File is not tracked or non-ignored by Git.");
    }
    return target;
  }

  private async isIgnored(relative: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["check-ignore", "-q", "--no-index", "--", relative], { cwd: this.root, windowsHide: true });
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === 1) return false;
      throw error;
    }
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name === "list_files") {
      const files = await this.fileList();
      return { content: `${files.slice(0, 300).join("\n")}${files.length > 300 ? `\n... ${files.length - 300} more files` : ""}` };
    }
    if (name === "read_file") {
      const { absolute } = await this.allowed(stringArg(args, "path"));
      const stat = await lstat(absolute);
      if (!stat.isFile()) throw new Error("Only regular files can be read.");
      if (stat.size > FILE_LIMIT) throw new Error(`File exceeds ${FILE_LIMIT} bytes; use search to locate the relevant section.`);
      const bytes = await readFile(absolute);
      if (bytes.includes(0)) throw new Error("Binary files cannot be read.");
      return { content: bytes.toString("utf8") };
    }
    if (name === "search") {
      const query = stringArg(args, "query");
      if (query.trim().length < 2 || query.length > 200) throw new Error("query must be 2-200 characters.");
      const files = await this.fileList();
      const matches: string[] = [];
      let scanned = 0;
      for (const file of files) {
        const { absolute } = await this.safePath(file);
        const stat = await lstat(absolute);
        if (!stat.isFile() || stat.size > FILE_LIMIT) continue;
        scanned += stat.size;
        if (scanned > SEARCH_BYTES) break;
        const bytes = await readFile(absolute);
        if (bytes.includes(0)) continue;
        const lines = bytes.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(query.toLowerCase())) {
            matches.push(`${file}:${i + 1}: ${lines[i].slice(0, 240)}`);
            if (matches.length >= 80) return { content: matches.join("\n") + "\n... result limit reached" };
          }
        }
      }
      return { content: matches.join("\n") || "No matches in scanned files." };
    }
    if (name === "apply_patch" && this.mode === "lead") {
      const relative = stringArg(args, "path");
      const oldText = stringArg(args, "oldText");
      const newText = stringArg(args, "newText");
      if (newText.length > 100_000) throw new Error("Patch content is too large.");
      const target = await this.safePath(relative);
      let exists = true;
      try { await lstat(target.absolute); } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") exists = false;
        else throw error;
      }
      if (!exists) {
        if (oldText !== "") throw new Error("New files require empty oldText.");
        if (await this.isIgnored(relative)) throw new Error("Cannot create a Git-ignored file.");
        await mkdir(path.dirname(target.absolute), { recursive: true });
        await writeFile(target.absolute, newText, { flag: "wx" });
        this.created.add(target.normalized);
        return { content: `Created ${target.normalized}` };
      }
      await this.allowed(relative);
      if (!oldText) throw new Error("Existing files require non-empty oldText.");
      const previous = await readFile(target.absolute, "utf8");
      if (previous.length > 100_000) throw new Error("File is too large to patch.");
      const first = previous.indexOf(oldText);
      if (first < 0 || previous.indexOf(oldText, first + oldText.length) >= 0) throw new Error("oldText must match exactly once.");
      await writeFile(target.absolute, previous.slice(0, first) + newText + previous.slice(first + oldText.length));
      return { content: `Updated ${target.normalized}` };
    }
    throw new Error(`Tool not available: ${name}`);
  }
}
