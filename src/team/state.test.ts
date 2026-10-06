import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { logEvent, subscribeToRunEvents, type TeamRunState } from "./state.js";

test("logEvent broadcasts the persisted event to subscribers", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "agent-team-events-"));
  const state = { id: "1234567890-abcd", runDir } as TeamRunState;
  const received: unknown[] = [];
  const unsubscribe = subscribeToRunEvents((runId, event) => received.push({ runId, event }));
  try {
    await logEvent(state, "wren", "finished", "Status board polish");
  } finally {
    unsubscribe();
  }
  const persisted = JSON.parse((await readFile(path.join(runDir, "events.jsonl"), "utf8")).trim());
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { runId: state.id, event: persisted });
  assert.equal(persisted.persona, "wren");
  assert.equal(persisted.event, "finished");
});
