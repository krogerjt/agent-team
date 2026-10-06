import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildEnvironmentTools, executeBuildEnvironmentTool } from "./environment-tools.js";
import { tempRepo } from "../coding/test-helpers.js";

test("desk environment inspection explains a disabled Mac and cannot run checks", async () => {
  const { root, parent } = await tempRepo();
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-team-env-test-"));
  const previous = process.env.AGENT_TEAM_DATA_DIR;
  process.env.AGENT_TEAM_DATA_DIR = data;
  try {
    const result = JSON.parse((await executeBuildEnvironmentTool("inspect_build_environment", root, root, false)).content);
    assert.equal(result.macHost.enabled, false);
    assert.match(result.guidance, /Mac Build Host/);
    assert.equal(buildEnvironmentTools(false).some((tool) => tool.name === "run_checks"), false);
    assert.equal(buildEnvironmentTools(true).some((tool) => tool.name === "run_checks"), true);
    await assert.rejects(() => executeBuildEnvironmentTool("run_checks", root, root, false), /not available/);
    const checks = JSON.parse((await executeBuildEnvironmentTool("run_checks", root, root, true)).content);
    assert.equal(checks[0].status, "missing");
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAM_DATA_DIR; else process.env.AGENT_TEAM_DATA_DIR = previous;
    assert.equal(path.dirname(parent), os.tmpdir());
    assert.equal(path.dirname(data), os.tmpdir());
    await rm(parent, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
