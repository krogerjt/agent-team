import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { git } from "./git.js";
import type { ToolDefinition, ToolResult } from "../core/provider.js";
import sharp from "sharp";
import OpenAI from "openai";

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
  description: "Change one file. First read the current file. For an existing file, oldText must be a unique exact substring copied from that read and newText replaces it. If it fails, reread the file and rebuild oldText; never reuse a failed patch. To create a new file, use oldText='' and newText as the complete contents. All paths are relative to the repository.",
  parameters: schema({ path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, ["path", "oldText", "newText"]),
};

const pngTool: ToolDefinition = {
  name: "create_png",
  description: "Render an existing repository SVG, PNG, JPEG or WebP into an opaque PNG. Use apply_patch to create an SVG first for new artwork. Preserves aspect ratio with padding, removes alpha, validates the output. For an Apple app icon use width=1024, height=1024 and a solid background such as #FFFFFF. Writes only inside this worktree; update the asset catalog separately.",
  parameters: schema({ source: { type: "string" }, path: { type: "string" }, width: { type: "integer", minimum: 1, maximum: 4096 }, height: { type: "integer", minimum: 1, maximum: 4096 }, background: { type: "string", description: "Opaque #RRGGBB background." } }, ["source", "path", "width", "height", "background"]),
};

const inspectImageTool: ToolDefinition = {
  name: "inspect_image",
  description: "Inspect a repository image's format, dimensions and alpha channel without reading binary data as text.",
  parameters: schema({ path: { type: "string" } }, ["path"]),
};

const generateImageTool: ToolDefinition = {
  name: "generate_png",
  description: "Create new artwork from a text prompt using the OpenAI Image API (billed API call). Requires OPENAI_API_KEY and AGENT_TEAM_IMAGE_MODEL configured on the host. Saves a validated opaque 1024×1024 PNG. For an existing SVG/icon use create_png instead to preserve its design without an API call.",
  parameters: schema({ prompt: { type: "string" }, path: { type: "string" }, background: { type: "string", description: "Opaque #RRGGBB background." } }, ["prompt", "path", "background"]),
};

/**
 * Converts a patch to CRLF when the target file uses CRLF, so a model sending "\n"-joined text can still patch a
 * Windows checkout and its new lines don't leave the file with mixed endings. Mixed-ending files keep exact matching.
 */
export function matchLineEndings(file: string, oldText: string, newText: string): { oldText: string; newText: string } {
  if (!file.includes("\r\n")) return { oldText, newText };
  const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");
  const converted = crlf(oldText);
  return file.includes(converted) ? { oldText: converted, newText: crlf(newText) } : { oldText, newText };
}

function stringArg(args: Record<string, unknown>, name: string): string {
  if (typeof args[name] !== "string") throw new Error(`${name} must be a string.`);
  return args[name];
}

function patchContext(previous: string, oldText: string): string {
  const anchor = oldText.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length >= 12);
  const position = anchor ? previous.indexOf(anchor) : -1;
  if (position >= 0) return previous.slice(Math.max(0, position - 2_000), Math.min(previous.length, position + 6_000));
  return previous.slice(0, 8_000);
}

export class WorkspaceTools {
  readonly definitions: ToolDefinition[];
  private readonly created = new Set<string>();

  constructor(readonly root: string, private readonly mode: ToolMode) {
    this.definitions = mode === "lead" ? [...readTools, inspectImageTool, patchTool, pngTool, generateImageTool] : [...readTools, inspectImageTool];
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
    if (name === "generate_png" && this.mode === "lead") {
      const target = await this.safePath(stringArg(args, "path"));
      if (!/\.png$/i.test(target.normalized)) throw new Error("Output path must end in .png.");
      if (await this.isIgnored(target.normalized)) throw new Error("Cannot write a Git-ignored file.");
      const background = stringArg(args, "background");
      if (!/^#[0-9a-f]{6}$/i.test(background)) throw new Error("Background must be an opaque #RRGGBB colour.");
      const prompt = stringArg(args, "prompt").trim();
      if (!prompt || prompt.length > 8_000) throw new Error("Prompt must contain 1–8,000 characters.");
      if (!process.env.OPENAI_API_KEY || !process.env.AGENT_TEAM_IMAGE_MODEL) throw new Error("Configure OPENAI_API_KEY and AGENT_TEAM_IMAGE_MODEL on the host for image generation. For existing artwork use create_png, which needs no API credentials.");
      const client = new OpenAI({ timeout: 180_000, maxRetries: 0 });
      const response = await client.images.generate({ model: process.env.AGENT_TEAM_IMAGE_MODEL, prompt, n: 1, size: "1024x1024", output_format: "png", background: "opaque" });
      const data = response.data?.[0]?.b64_json;
      if (!data || data.length > 30_000_000) throw new Error("Image service did not return a usable PNG.");
      const output = await sharp(Buffer.from(data, "base64"), { limitInputPixels: 16_777_216 })
        .resize(1024, 1024, { fit: "contain", background }).flatten({ background }).removeAlpha().png().toBuffer();
      const metadata = await sharp(output).metadata();
      if (metadata.format !== "png" || metadata.width !== 1024 || metadata.height !== 1024 || metadata.hasAlpha) throw new Error("Generated PNG validation failed.");
      await mkdir(path.dirname(target.absolute), { recursive: true });
      await writeFile(target.absolute, output);
      this.created.add(target.normalized);
      return { content: `Generated ${target.normalized}: PNG 1024×1024, opaque, no alpha channel. Image model: ${process.env.AGENT_TEAM_IMAGE_MODEL}.` };
    }
    if (name === "inspect_image") {
      const { absolute } = await this.allowed(stringArg(args, "path"));
      if ((await lstat(absolute)).size > 10_000_000) throw new Error("Image exceeds 10 MB.");
      const metadata = await sharp(await readFile(absolute), { limitInputPixels: 16_777_216 }).metadata();
      return { content: JSON.stringify({ format: metadata.format, width: metadata.width, height: metadata.height, hasAlpha: metadata.hasAlpha }) };
    }
    if (name === "create_png" && this.mode === "lead") {
      const source = await this.allowed(stringArg(args, "source"));
      const target = await this.safePath(stringArg(args, "path"));
      if (!/\.png$/i.test(target.normalized)) throw new Error("Output path must end in .png.");
      if (source.absolute.toLowerCase() === target.absolute.toLowerCase()) throw new Error("Use a separate output path to preserve the source.");
      if (await this.isIgnored(target.normalized)) throw new Error("Cannot write a Git-ignored file.");
      const { width, height } = args;
      if (!Number.isInteger(width) || !Number.isInteger(height) || Number(width) < 1 || Number(height) < 1 || Number(width) > 4096 || Number(height) > 4096) throw new Error("Dimensions must be integers from 1 to 4096.");
      const background = stringArg(args, "background");
      if (!/^#[0-9a-f]{6}$/i.test(background)) throw new Error("Background must be an opaque #RRGGBB colour.");
      if ((await lstat(source.absolute)).size > 10_000_000) throw new Error("Image exceeds 10 MB.");
      const bytes = await readFile(source.absolute);
      const metadata = await sharp(bytes, { limitInputPixels: 16_777_216 }).metadata();
      if (!["svg", "png", "jpeg", "webp"].includes(metadata.format ?? "")) throw new Error("Use SVG, PNG, JPEG or WebP input.");
      // Reject SVG resource references: conversion must not read outside the repository or fetch URLs.
      if (metadata.format === "svg") {
        const svg = bytes.toString("utf8");
        const references = [...svg.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1|\burl\s*\(\s*([^)]*)\)/gi)];
        if (/<!DOCTYPE|<!ENTITY|@import/i.test(svg) || references.some((match) => !(match[2] ?? match[3] ?? "").trim().replace(/^["']|["']$/g, "").startsWith("#"))) throw new Error("SVG must be self-contained, without external resource references.");
      }
      const output = await sharp(bytes, { limitInputPixels: 16_777_216 })
        .resize(Number(width), Number(height), { fit: "contain", background })
        .flatten({ background }).removeAlpha().png().toBuffer();
      const result = await sharp(output).metadata();
      if (result.format !== "png" || result.width !== width || result.height !== height || result.hasAlpha) throw new Error("PNG validation failed.");
      await mkdir(path.dirname(target.absolute), { recursive: true });
      await writeFile(target.absolute, output);
      this.created.add(target.normalized);
      return { content: `Created ${target.normalized}: PNG ${result.width}×${result.height}, opaque, no alpha channel (${output.length} bytes).` };
    }
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
      let oldText = stringArg(args, "oldText");
      let newText = stringArg(args, "newText");
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
      // Windows checkouts (core.autocrlf) use CRLF, but models send "\n"; match and write in the file's own line endings.
      ({ oldText, newText } = matchLineEndings(previous, oldText, newText));
      const first = previous.indexOf(oldText);
      const second = first >= 0 ? previous.indexOf(oldText, first + oldText.length) : -1;
      if (first < 0 || second >= 0) {
        const reason = first < 0 ? "matched 0 times" : "matched more than once";
        throw new Error(
          `Patch context for ${target.normalized} ${reason}. ` +
          `Read the current file and copy a smaller unique oldText snippet.\n` +
          `Submitted oldText:\n${oldText.slice(0, 2_000)}\n` +
          `Current file context:\n${patchContext(previous, oldText)}`,
        );
      }
      await writeFile(target.absolute, previous.slice(0, first) + newText + previous.slice(first + oldText.length));
      return { content: `Updated ${target.normalized}` };
    }
    throw new Error(`Tool not available: ${name}`);
  }
}
