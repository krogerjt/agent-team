import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelProvider, ModelRequest, ModelResponse, ToolRequest, ToolResponse } from "../core/provider.js";
import { runCodingTask } from "./workflow.js";
import { tempRepo } from "./test-helpers.js";

const cleanup: string[] = [];
after(async () => {
  for (const target of cleanup) {
    assert.equal(path.dirname(target), os.tmpdir());
    await rm(target, { recursive: true, force: true });
  }
});

test("runs at most one repair pass after review", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push(parent);
  let leadCalls = 0;
  function fake(name: string): ModelProvider & { generateWithTools(request: ToolRequest): Promise<ToolResponse> } {
    return {
      name,
      async generate(_request: ModelRequest): Promise<ModelResponse> { return { text: name }; },
      async generateWithTools(request: ToolRequest): Promise<ToolResponse> {
        if (name === "lead") {
          leadCalls++;
          await request.execute("apply_patch", { path: "note.txt", oldText: leadCalls === 1 ? "hello" : "first", newText: leadCalls === 1 ? "first" : "second" });
        }
        return { text: name === "reviewer" ? "CHANGES_NEEDED: improve wording" : name, toolCalls: name === "lead" ? 1 : 0 };
      },
    };
  }
  const result = await runCodingTask(root, "Improve the note", { researcher: fake("researcher"), lead: fake("lead"), reviewer: fake("reviewer") });
  assert.equal(leadCalls, 2);
  assert.equal(result.repaired, true);
  assert.match(result.diff, /second world/);
  assert.equal(result.checks[0].status, "missing");
});
