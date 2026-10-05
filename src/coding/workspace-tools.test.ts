import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceTools } from "./workspace-tools.js";
import { tempRepo } from "./test-helpers.js";

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
