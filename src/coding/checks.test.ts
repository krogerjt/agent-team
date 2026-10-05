import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkEnvironment, detectChecks } from "./checks.js";
import { tempRepo } from "./test-helpers.js";

const cleanup: string[] = [];
after(async () => {
  for (const target of cleanup) {
    assert.equal(path.dirname(target), os.tmpdir());
    await rm(target, { recursive: true, force: true });
  }
});

test("detects Node, .NET, and Python checks without model commands", async () => {
  const { root, parent } = await tempRepo();
  cleanup.push(parent);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", typecheck: "tsc --noEmit" } }));
  await writeFile(path.join(root, "service.sln"), "");
  await writeFile(path.join(root, "pyproject.toml"), "[tool.pytest.ini_options]\n");
  assert.deepEqual((await detectChecks(root)).map((check) => check.name), ["npm test", "npm run typecheck", "dotnet test", "python -m pytest"]);
});

test("does not pass API credentials to repository checks", () => {
  assert.deepEqual(checkEnvironment({ PATH: "bin", OPENAI_API_KEY: "private", ANTHROPIC_API_KEY: "private", AWS_SECRET_ACCESS_KEY: "private" }), { CI: "1", PATH: "bin" });
});
