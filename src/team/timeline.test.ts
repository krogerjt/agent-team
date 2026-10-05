import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ToolCapableProvider } from "../core/provider.js";
import { tempRepo } from "../coding/test-helpers.js";
import { createRunState, logEvent, repoHome } from "./state.js";
import { appendTimeline, executeMemoryTool, getTimelineEntry, searchTimeline } from "./timeline.js";
import { messageTeamPersona } from "./workflow.js";

test("dated persona timelines retain old work and search by feature, file, words, and time", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-timeline-data-"));
  const { root, parent } = await tempRepo();
  const previous = process.env.AGENT_TEAM_DATA_DIR;
  process.env.AGENT_TEAM_DATA_DIR = data;
  try {
    const run = await createRunState(root, "Checkout page", "baseline");
    await logEvent(run, "wren", "finished", "Improved checkout form layout");
    await logEvent(run, "wren", "tool", 'apply_patch {"path":"src/checkout/card.tsx","oldText":"before","newText":"after"}');
    const migrated = await searchTimeline(root, "wren", { query: "checkout form" });
    assert.equal(migrated.total, 1);
    assert.equal(migrated.entries[0].source, "legacy");
    const oldFile = await searchTimeline(root, "wren", { file: "card.tsx" });
    assert.equal(oldFile.total, 1);
    assert.equal(oldFile.entries[0].summary, "Wren Patched src/checkout/card.tsx");

    for (let index = 0; index < 105; index++) {
      await appendTimeline(root, "wren", {
        at: `2025-03-${String(index % 28 + 1).padStart(2, "0")}T10:${String(Math.floor(index / 28)).padStart(2, "0")}:00.000Z`,
        event: "worked", summary: `Adjusted checkout card ${index}`, detail: `Card ${index} changed after user feedback.`,
        feature: "Checkout page", files: ["src/checkout/card.tsx"], runId: "old-run", source: "run",
      });
    }
    await appendTimeline(root, "wren", {
      at: "2025-04-03T12:00:00.000Z", event: "worked", summary: "Polished account page", detail: "Changed account colors.",
      feature: "Account page", files: ["src/account/page.tsx"], source: "run",
    });
    const march = await searchTimeline(root, "wren", { from: "2025-03-01", to: "2025-03-31", query: "card 104", feature: "Checkout", file: "card.tsx" });
    assert.equal(march.total, 1);
    assert.match(march.entries[0].summary, /card 104/);
    const old = await searchTimeline(root, "wren", { from: "2025-03-01", to: "2025-03-31", limit: 5 });
    assert.equal(old.total, 105);
    assert.equal(old.entries.length, 5);
    assert.equal((await getTimelineEntry(root, "wren", old.entries[0].id))?.id, old.entries[0].id);
    assert.equal((await searchTimeline(root, "kit", { query: "checkout" })).total, 0);
    const result = await executeMemoryTool(root, "wren", "search_memory", { query: "account", limit: 2 });
    assert.match(result.content, /Polished account page/);
    assert.doesNotMatch(result.content, /Changed account colors/);
    const month = await readFile(path.join(repoHome(root), "personas", "wren", "timeline", "2025-03.jsonl"), "utf8");
    assert.match(month, /"at":"2025-03/);
    assert.match(month, /"summary":"Adjusted checkout card 0"/);

    const provider: ToolCapableProvider = {
      name: "memory-probe",
      async generate() { return { text: "unused" }; },
      async generateWithTools(request) {
        assert(request.tools.some((tool) => tool.name === "search_memory"));
        const found = await request.execute("search_memory", { query: "account", limit: 1 });
        assert.match(found.content, /Polished account page/);
        return { text: "I found my account-page work in the timeline.", toolCalls: 1 };
      },
    };
    assert.match(await messageTeamPersona(run.runDir, "wren", "What did you work on?", provider), /timeline/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAM_DATA_DIR;
    else process.env.AGENT_TEAM_DATA_DIR = previous;
    await rm(data, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
