import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendActivity, appendChat, configuredProvider, personaContext, readPersona, updatePersona } from "./persona-store.js";
import { repoHome } from "./state.js";
import { chatTeamPersona } from "./workflow.js";

test("each persona keeps model choice, traits, memory, work, and chat independently", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-personas-"));
  const previous = process.env.AGENT_TEAM_DATA_DIR;
  process.env.AGENT_TEAM_DATA_DIR = home;
  const repo = path.join(home, "repo");
  try {
    await updatePersona(repo, "wren", { traits: "Notices visual details", memory: "Use generous spacing", provider: "mock" });
    await Promise.all(Array.from({ length: 12 }, (_, index) => appendActivity(repo, "wren", { at: String(index), runId: "run-1", event: "worked", detail: `Task ${index}` })));
    await appendChat(repo, "wren", { at: "now", role: "user", text: "How is it going?" });
    await appendChat(repo, "wren", { at: "later", role: "assistant", text: "The layout is coming along." });
    const wren = await readPersona(repo, "wren");
    const kit = await readPersona(repo, "kit");
    assert.equal(wren.traits, "Notices visual details");
    assert.equal(wren.memory, "Use generous spacing");
    assert.equal(wren.activity.length, 12);
    assert.equal(wren.chat.length, 2);
    assert.equal(kit.chat.length, 0);
    assert.equal((await configuredProvider(repo, "wren")).name, "mock");
    assert.match(await personaContext(repo, "wren"), /Use generous spacing/);
    assert.match(await readFile(path.join(repoHome(repo), "personas", "wren.json"), "utf8"), /Task 11/);
    const reply = await chatTeamPersona(repo, "wren", "What should our layout feel like?");
    assert.match(reply, /What should our layout feel like/);
    assert.equal((await readPersona(repo, "wren")).chat.length, 4);
    await assert.rejects(updatePersona(repo, "kit", { provider: "anthropic", model: "" }), /model name/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAM_DATA_DIR;
    else process.env.AGENT_TEAM_DATA_DIR = previous;
    await rm(home, { recursive: true, force: true });
  }
});
