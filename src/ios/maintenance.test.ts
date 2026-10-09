import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { saveRemoteBuildHost } from "../remote/settings.js";
import { MAINTENANCE_ACTIONS, maintenanceScript, parseMaintenance, runMaintenance } from "./maintenance.js";
import { saveOperationRecord } from "./store.js";
import { executeIosTool } from "./tools.js";
import { healthyApp, host, iosRepo, withData } from "./test-helpers.js";

const json = (result: { content: string }) => JSON.parse(result.content);

test("every maintenance script is valid shell and confined to the tool's own folder", () => {
  const bash = spawnSync("bash", ["-c", "true"]).status === 0;
  for (const action of MAINTENANCE_ACTIONS) {
    const script = maintenanceScript(action, ".agent-team-builder");
    assert.match(script, /R="\$HOME"\/'\.agent-team-builder'/);
    if (bash) { const check = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }); assert.equal(check.status, 0, `${action}: ${check.stderr}`); }
    // Every removal or kill is anchored on $R (the tool's folder); nothing else on the Mac is named.
    for (const line of script.split("\n").filter((entry) => /\brm\b|\bpkill\b|\bkill\b|-exec/.test(entry))) assert.match(line, /\$R\//, `${action}: ${line}`);
    assert.doesNotMatch(script, /rm -rf (?!"\$R\/cache\/DerivedData")(?!\{\})/, action);
    assert.doesNotMatch(script, /sudo|\/Applications|\/Library\/(?!Logs\/DiagnosticReports)|Developer\/Xcode|\.ssh|Keychains/, action);
  }
  assert.doesNotMatch(maintenanceScript("diagnose", ".agent-team-builder"), /\brm\b|pkill|kill |-exec/, "diagnose is read-only");
});

test("diagnose output is parsed and turned into specific hints; clearing refuses while a build is running", async () => {
  const output = "LOAD\t127.62, 145.17, 70.75\nDISK_FREE_GB\t7\nXCODE\tXcode 16.2 Build version 16C5032a \nJOB_FOLDERS\t9\nBUILD_PROCESSES\t333 xcodebuild -project A;\nBUILD_CACHE_SIZE\t4.1G\nCRASH_REPORTS_LAST_DAY\t0\n";
  const scripts: string[] = [];
  const result = await runMaintenance("diagnose", host, async (_h, script) => { scripts.push(script); return { code: 0, output }; });
  assert.equal(result.values.DISK_FREE_GB, "7");
  const text = result.hints.join(" | ");
  for (const expected of [/Load average is 127/, /Build processes are running/, /Under 10 GB/, /leftover job folders/, /Xcode 26/]) assert.match(text, expected);
  assert.equal(scripts.length, 1);
  const refused = await runMaintenance("clear-build-cache", host, async () => ({ code: 0, output: "REFUSED\tA build is using the cache right now.\n" }));
  assert.equal(refused.ok, false);
  const healthy = await runMaintenance("diagnose", host, async () => ({ code: 0, output: "LOAD\t1.2, 1.0, 0.9\nDISK_FREE_GB\t140\nXCODE\tXcode 26.3 Build version 17C519 \nJOB_FOLDERS\t0\nBUILD_PROCESSES\t\n" }));
  assert.deepEqual(healthy.hints, []);
  assert.deepEqual((await runMaintenance("diagnose", { ...host, enabled: false }, async () => { throw new Error("must not run"); })).ok, false);
  await assert.rejects(() => runMaintenance("format-disk" as never, host, async () => ({ code: 0, output: "" })), /Unknown maintenance action/);
  assert.deepEqual(parseMaintenance("junk\nKEY\tvalue\nlower\tx\nNOTE\tpassword=abc12345 here"), { KEY: "value", NOTE: "password=[redacted] here" });
});

test("through the tool: maintenance needs an enabled host, validates the action, and recent runs can be listed and read without secrets", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      const ctx = { root: repo.root, repo: repo.root, writable: false, run: (async () => ({ code: 0, output: "LOAD\t0.5\nDISK_FREE_GB\t100\nXCODE\tXcode 26.3 \n" })) as never };
      assert.equal(json(await executeIosTool("ios_mac_maintenance", { action: "diagnose" }, ctx)).ok, false, "no host enabled yet");
      await saveRemoteBuildHost({ enabled: true, target: "build-mac", root: ".agent-team-builder" });
      const diagnosed = json(await executeIosTool("ios_mac_maintenance", { action: "diagnose" }, ctx));
      assert.equal(diagnosed.ok, true); assert.equal(diagnosed.values.DISK_FREE_GB, "100");
      await assert.rejects(() => executeIosTool("ios_mac_maintenance", { action: "rm -rf /" }, ctx), /Unknown maintenance action/);

      assert.deepEqual(json(await executeIosTool("ios_recent_runs", {}, ctx)).runs, []);
      await saveOperationRecord(repo.root, "2026-10-08T10-00-00-000Z-archive-aaaa1111", { operation: "archive", status: "failed", verified: false, summary: "archive failed (provisioning)", failureClass: "provisioning", commands: [], output: "error: No profiles\naltool --apiKey LEAKME1234 --apiIssuer 69a6de70-03db-47e3-e053-5b8c7c11a4d1", context: { root: repo.root, dirty: false, treeHash: "x", at: "2026-10-08T10:00:00.000Z" } });
      await saveOperationRecord(repo.root, "2026-10-08T11-00-00-000Z-export-bbbb2222", { operation: "export", status: "success", verified: true, summary: "Export verified", commands: [] });
      const listed = json(await executeIosTool("ios_recent_runs", {}, ctx)).runs;
      assert.deepEqual(listed.map((run: { operation: string }) => run.operation), ["export", "archive"], "newest first");
      const detail = json(await executeIosTool("ios_recent_runs", { id: "2026-10-08T10-00-00-000Z-archive-aaaa1111" }, ctx));
      assert.match(detail.output_tail, /No profiles/); assert.ok(!detail.output_tail.includes("LEAKME1234") && !JSON.stringify(detail).includes("69a6de70"));
      assert.equal(detail.result.failureClass, "provisioning"); assert.equal(detail.result.output, undefined);
      await assert.rejects(() => executeIosTool("ios_recent_runs", { id: "../../etc/passwd" }, ctx), /not a run id/);
      assert.equal((await executeIosTool("ios_recent_runs", { id: "no-such-run-1234" }, ctx)).isError, true);
    });
  } finally { await repo.cleanup(); }
});
