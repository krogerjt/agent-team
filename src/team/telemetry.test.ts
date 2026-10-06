import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readPersona, recordPersonaUsage } from "./persona-store.js";

test("persona model stats keep known tokens, unknown usage, and monthly rollups", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-team-telemetry-"));
  const previous = process.env.AGENT_TEAM_DATA_DIR;
  process.env.AGENT_TEAM_DATA_DIR = data;
  try {
    const repo = path.join(data, "repo");
    await recordPersonaUsage(repo, "kit", { provider: "openai", model: "luna" }, {
      at: "2026-10-06T12:00:00.000Z", interactionDurationMs: 500, toolCalls: 2, calls: [
        { durationMs: 200, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
        { durationMs: 100 },
      ],
    });
    await recordPersonaUsage(repo, "kit", { provider: "openai", model: "luna" }, {
      at: "2026-10-07T12:00:00.000Z", interactionDurationMs: 300, calls: [{ durationMs: 50, usage: { inputTokens: 4, outputTokens: 6 } }],
    });
    const stats = (await readPersona(repo, "kit")).modelStats[0];
    assert.equal(stats.calls, 3);
    assert.equal(stats.unknownUsageCalls, 1);
    assert.equal(stats.inputTokens, 14);
    assert.equal(stats.outputTokens, 11);
    assert.equal(stats.totalTokens, 25);
    assert.equal(stats.interactions, 2);
    assert.equal(stats.monthly["2026-10"].calls, 3);
    assert.equal(stats.monthly["2026-10"].toolCalls, 2);
    assert.match(await readFile(path.join(data, "repos", `repo-${(await import("node:crypto")).createHash("sha256").update(repo.toLowerCase()).digest("hex").slice(0, 12)}`, "personas", "kit.json"), "utf8"), /modelStats/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAM_DATA_DIR;
    else process.env.AGENT_TEAM_DATA_DIR = previous;
  }
});
