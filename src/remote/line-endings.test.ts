import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NORMALIZE_SCRIPT_LINE_ENDINGS } from "./line-endings.js";

const hasPerl = spawnSync("bash", ["-c", "command -v perl"]).status === 0;

test("CRLF shell scripts are converted to LF and then run; other files and .git are left alone", { skip: !hasPerl }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-team-eol-"));
  try {
    const crlf = (text: string) => text.split("\n").join("\r\n");
    await mkdir(path.join(dir, "ios"), { recursive: true }); await mkdir(path.join(dir, ".git"), { recursive: true });
    await writeFile(path.join(dir, "ios/write-local.sh"), crlf("#!/bin/sh\nset -eu\necho \"url=$SERVER\"\n"));
    await writeFile(path.join(dir, "ios/run.command"), crlf("echo command\n"));
    await writeFile(path.join(dir, "Podfile"), crlf("platform :ios\n"));
    await writeFile(path.join(dir, "notes.txt"), crlf("keep my line endings\n"));
    await writeFile(path.join(dir, ".git/hook.sh"), crlf("echo hook\n"));
    await writeFile(path.join(dir, "image.png"), Buffer.from([0x89, 0x50, 0x0d, 0x0a, 0x1a, 0x0a, 0x0d, 0x0a]));

    // (Whether the CR breaks `set -eu` depends on the shell; the Mac's /bin/sh rejects it, so it must be gone.)
    assert.ok((await readFile(path.join(dir, "ios/write-local.sh"), "utf8")).includes("\r\n"), "the script starts out with CRLF");

    const fix = spawnSync("bash", ["-c", NORMALIZE_SCRIPT_LINE_ENDINGS], { cwd: dir, encoding: "utf8" });
    assert.equal(fix.status, 0, fix.stderr);
    for (const converted of ["ios/write-local.sh", "ios/run.command", "Podfile"]) assert.ok(!(await readFile(path.join(dir, converted), "utf8")).includes("\r"), converted);
    assert.ok((await readFile(path.join(dir, "notes.txt"), "utf8")).includes("\r\n"), "plain text is untouched");
    assert.ok((await readFile(path.join(dir, ".git/hook.sh"), "utf8")).includes("\r"), ".git is untouched");
    assert.deepEqual([...await readFile(path.join(dir, "image.png"))], [0x89, 0x50, 0x0d, 0x0a, 0x1a, 0x0a, 0x0d, 0x0a], "binary files are untouched");

    const after = spawnSync("sh", ["ios/write-local.sh"], { cwd: dir, encoding: "utf8", env: { ...process.env, SERVER: "https://x" } });
    assert.equal(after.status, 0, after.stderr); assert.match(after.stdout, /^url=https:\/\/x/);
    assert.equal(spawnSync("bash", ["-c", NORMALIZE_SCRIPT_LINE_ENDINGS], { cwd: dir }).status, 0, "running it twice is harmless");
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }
});

test("the snippet is valid shell and never fails the build by itself", () => {
  assert.equal(spawnSync("bash", ["-n"], { input: NORMALIZE_SCRIPT_LINE_ENDINGS }).status, 0);
  assert.match(NORMALIZE_SCRIPT_LINE_ENDINGS, /\|\| true$/);
});
