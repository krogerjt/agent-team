import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceTools } from "./workspace-tools.js";
import { tempRepo } from "./test-helpers.js";
import sharp from "sharp";
import { Images } from "openai/resources/images";

const cleanup: string[] = [];
after(async () => {
  for (const target of cleanup) {
    assert.equal(path.dirname(target), os.tmpdir());
    await rm(target, { recursive: true, force: true });
  }
});

test("restricts paths and applies exact text patches", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push(parent);
  const reader = new WorkspaceTools(root, "researcher");
  const lead = new WorkspaceTools(root, "lead");
  await assert.rejects(() => reader.execute("read_file", { path: "../outside.txt" }), /allowed repository|escapes/);
  await assert.rejects(() => reader.execute("read_file", { path: ".env" }), /not tracked/);
  await assert.rejects(() => reader.execute("apply_patch", { path: "note.txt", oldText: "hello", newText: "bye" }), /not available/);
  await lead.execute("apply_patch", { path: "note.txt", oldText: "hello", newText: "goodbye" });
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "goodbye world\n");
  await assert.rejects(() => lead.execute("apply_patch", { path: "note.txt", oldText: "missing", newText: "x" }), /match exactly once/);
  await lead.execute("apply_patch", { path: "new.txt", oldText: "", newText: "created\n" });
  assert.match((await reader.execute("list_files", {})).content, /new.txt/);
});

test("renders SVG into a validated opaque app icon and restricts writes", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push(parent);
  const tools = new WorkspaceTools(root, "lead");
  await tools.execute("apply_patch", { path: "icon.svg", oldText: "", newText: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><rect width="100" height="50" fill="url(#g)"/></svg>' });
  const args = { source: "icon.svg", path: "Assets.xcassets/AppIcon.appiconset/icon.png", width: 1024, height: 1024, background: "#FFFFFF" };
  assert.match((await tools.execute("create_png", args)).content, /opaque, no alpha/);
  const bytes = await readFile(path.join(root, args.path));
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 1024);
  assert.equal(metadata.height, 1024);
  assert.equal(metadata.hasAlpha, false);
  const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data.subarray(0, 3)], [255, 255, 255]);
  assert.match((await tools.execute("inspect_image", { path: args.path })).content, /"hasAlpha":false/);
  await assert.rejects(() => tools.execute("create_png", { ...args, path: "../escape.png" }), /allowed repository|escapes/);
  await assert.rejects(() => tools.execute("create_png", { ...args, path: "node_modules/icon.png" }), /Git-ignored/);
  await assert.rejects(() => tools.execute("create_png", { ...args, background: "transparent" }), /opaque/);
  await assert.rejects(() => tools.execute("create_png", { ...args, width: 4097 }), /Dimensions/);
  await assert.rejects(() => new WorkspaceTools(root, "researcher").execute("create_png", args), /not available/);
  await tools.execute("apply_patch", { path: "external.svg", oldText: "", newText: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="file:///outside.png" width="10" height="10"/></svg>' });
  await assert.rejects(() => tools.execute("create_png", { ...args, source: "external.svg" }), /self-contained/);
});

test("AI artwork requests PNG and normalizes opacity without a live API call", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push(parent);
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.AGENT_TEAM_IMAGE_MODEL;
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
  const generate = mock.method(Images.prototype, "generate", async (request: Record<string, unknown>) => {
    assert.equal(request.output_format, "png");
    assert.equal(request.size, "1024x1024");
    assert.equal(request.background, "opaque");
    return { created: 0, data: [{ b64_json: bytes.toString("base64") }] };
  });
  try {
    const tools = new WorkspaceTools(root, "lead");
    const args = { path: "generated.png", prompt: "Trading card graveyard icon", background: "#FFFFFF" };
    delete process.env.AGENT_TEAM_IMAGE_MODEL;
    await assert.rejects(() => tools.execute("generate_png", args), /Configure OPENAI_API_KEY/);
    process.env.OPENAI_API_KEY = "test-key";
    process.env.AGENT_TEAM_IMAGE_MODEL = "test-image-model";
    assert.match((await tools.execute("generate_png", args)).content, /opaque, no alpha/);
    assert.equal(generate.mock.calls.length, 1);
    const image = JSON.parse((await tools.execute("inspect_image", { path: "generated.png" })).content);
    assert.deepEqual(image, { format: "png", width: 1024, height: 1024, hasAlpha: false });
  } finally {
    generate.mock.restore();
    if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
    if (model === undefined) delete process.env.AGENT_TEAM_IMAGE_MODEL; else process.env.AGENT_TEAM_IMAGE_MODEL = model;
  }
});
