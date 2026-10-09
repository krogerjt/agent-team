import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { git } from "../coding/git.js";
import { createHollisSession } from "./hollis-session.js";
import { PLAYBOOK, playbookIndex, playbookTopic } from "./playbook.js";
import { healthyApp, iosRepo } from "./test-helpers.js";

const json = (result: { content: string } | undefined) => JSON.parse(result!.content);

async function committedApp() {
  const repo = await iosRepo(healthyApp());
  await git(repo.root, ["add", "-A"]);
  await git(repo.root, ["commit", "-qm", "app"]);
  return repo;
}

test("Hollis's tool list covers iOS, playbook, workspace, web and file tools, and offers no way to grant permissions, push or submit", async () => {
  const repo = await committedApp();
  try {
    const session = createHollisSession({ repo: repo.root, root: repo.root, writable: false });
    const names = session.definitions.map((definition) => definition.name);
    for (const expected of ["ios_playbook", "ios_run_operation", "ios_prepare_release", "ios_open_release_workspace", "ios_commit_release_changes", "web_search", "web_fetch", "read_file", "apply_patch", "create_png"]) assert.ok(names.includes(expected), expected);
    assert.ok(!names.includes("generate_png"), "no billed image generation");
    assert.ok(!names.some((name) => /grant|push|merge|submit|settings|permission|pages/i.test(name)), names.join(","));
    assert.equal(new Set(names).size, names.length, "no duplicate tool names");
    assert.equal(await session.execute("unknown_tool", {}), undefined);
  } finally { await repo.cleanup(); }
});

test("edits are refused in the user's checkout; an opened release workspace is separate, editable and commits locally only", async () => {
  const repo = await committedApp();
  try {
    await writeFile(path.join(repo.root, "scratch.txt"), "uncommitted work\n");
    const session = createHollisSession({ repo: repo.root, root: repo.root, writable: false });
    const refused = await session.execute("apply_patch", { path: "NOTES.md", oldText: "", newText: "hello\n" });
    assert.equal(refused?.isError, true); assert.match(refused!.content, /ios_open_release_workspace/);
    const earlyCommit = await session.execute("ios_commit_release_changes", { message: "x" });
    assert.equal(earlyCommit?.isError, true);

    const opened = json(await session.execute("ios_open_release_workspace", {}));
    assert.notEqual(path.resolve(opened.workspace), path.resolve(repo.root));
    assert.match(opened.branch, /^codex\/hollis-release-/);
    assert.match(opened.note, /uncommitted change/);
    assert.equal(session.writable(), true);
    assert.match(json(await session.execute("ios_open_release_workspace", {})).note, /already open/);

    const written = await session.execute("apply_patch", { path: "NOTES.md", oldText: "", newText: "release notes\n" });
    assert.notEqual(written?.isError, true, written?.content ?? "no result");
    assert.equal(await readFile(path.join(opened.workspace, "NOTES.md"), "utf8"), "release notes\n");
    await assert.rejects(() => readFile(path.join(repo.root, "NOTES.md"), "utf8"), "the user's checkout is untouched");

    for (const bad of ["", "two\nlines", "x".repeat(201)]) assert.equal((await session.execute("ios_commit_release_changes", { message: bad }))?.isError, true);
    const committed = json(await session.execute("ios_commit_release_changes", { message: "Add release notes" }));
    assert.equal(committed.committed, true); assert.match(committed.note, /nothing was pushed/);
    assert.equal(await git(opened.workspace, ["log", "-1", "--format=%an|%s"]), "Agent Team Hollis|Add release notes");
    assert.equal(await git(opened.workspace, ["status", "--porcelain"]), "");
    assert.equal(json(await session.execute("ios_commit_release_changes", { message: "again" })).committed, false);
    assert.match(await git(repo.root, ["status", "--porcelain"]), /scratch\.txt/);
  } finally { await repo.cleanup(); }
});

test("committing refuses anything that looks like a credential and leaves nothing staged", async () => {
  const repo = await committedApp();
  try {
    const session = createHollisSession({ repo: repo.root, root: repo.root, writable: false });
    const opened = json(await session.execute("ios_open_release_workspace", {}));
    await session.execute("apply_patch", { path: "certs/dist.p12", oldText: "", newText: "not really a certificate\n" });
    await session.execute("apply_patch", { path: "keys/AuthKey_ABCDE12345.p8", oldText: "", newText: "-----BEGIN PRIVATE KEY-----\n" });
    await session.execute("apply_patch", { path: "ok.md", oldText: "", newText: "fine\n" });
    const refused = await session.execute("ios_commit_release_changes", { message: "oops" });
    assert.equal(refused?.isError, true); assert.match(refused!.content, /dist\.p12/); assert.match(refused!.content, /AuthKey_ABCDE12345\.p8/);
    assert.equal(await git(opened.workspace, ["diff", "--cached", "--name-only"]), "", "nothing left staged");
    assert.equal(await git(opened.workspace, ["rev-list", "--count", "HEAD"]), "2", "no new commit");
  } finally { await repo.cleanup(); }
});

test("a session started in an existing worktree is writable, and web and playbook tools run through it", async () => {
  const repo = await committedApp();
  try {
    const fetched: string[] = [];
    const session = createHollisSession({ repo: repo.root, root: repo.root, writable: true, web: { resolve: async () => ["93.184.216.34"], fetch: (async (url: URL) => { fetched.push(String(url)); return new Response("<title>Doc</title><p>Admin keys can create cloud certificates</p>", { headers: { "content-type": "text/html" } }); }) as never } });
    const page = json(await session.execute("web_fetch", { url: "https://developer.apple.com/documentation/x" }));
    assert.match(page.text, /Admin keys/); assert.deepEqual(fetched, ["https://developer.apple.com/documentation/x"]);
    const refusedSecret = await session.execute("web_search", { query: "altool --apiKey ABC123DEF4 failed" });
    assert.equal(refusedSecret?.isError, true); assert.equal(fetched.length, 1);
    const topic = json(await session.execute("ios_playbook", { topic: "credentials" }));
    assert.match(topic.text, /ADMIN/);
    assert.deepEqual(json(await session.execute("ios_playbook", {})).topics.split("\n").length, PLAYBOOK.length);
    assert.equal((await session.execute("ios_playbook", { topic: "nonsense" }))?.isError, true);
  } finally { await repo.cleanup(); }
});

test("readiness mode (the host's automatic hand-off) cannot edit, open a workspace, or run signing and upload operations", async () => {
  const repo = await committedApp();
  try {
    const session = createHollisSession({ repo: repo.root, root: repo.root, writable: true, mode: "readiness" });
    const names = session.definitions.map((definition) => definition.name);
    for (const hidden of ["apply_patch", "create_png", "ios_open_release_workspace", "ios_commit_release_changes"]) assert.ok(!names.includes(hidden), hidden);
    for (const kept of ["ios_discover_project", "ios_check_readiness", "ios_release_audit", "ios_release_preflight", "ios_recent_runs", "ios_playbook", "web_search", "read_file"]) assert.ok(names.includes(kept), kept);
    assert.equal(session.writable(), false, "even if the caller asked for a writable root");
    for (const hidden of ["apply_patch", "ios_open_release_workspace", "ios_commit_release_changes"]) {
      const refused = await session.execute(hidden, { path: "x", oldText: "", newText: "y", message: "m" });
      assert.equal(refused?.isError, true, hidden); assert.match(refused!.content, /readiness stage/);
    }
    for (const operation of ["archive", "export", "upload", "build-release", "install-device"]) {
      const refused = await session.execute("ios_run_operation", { operation });
      assert.equal(refused?.isError, true, operation); assert.match(refused!.content, /readiness stage/); assert.match(refused!.content, /dryRun=true/);
    }
    const preview = await session.execute("ios_run_operation", { operation: "archive", dryRun: true });
    assert.doesNotMatch(preview!.content, /readiness stage/, "a dry run is allowed through to the normal checks");
    const simulator = await session.execute("ios_run_operation", { operation: "build-simulator", dryRun: true });
    assert.doesNotMatch(simulator!.content, /readiness stage/);
  } finally { await repo.cleanup(); }
});

test("the playbook is complete, specific, and contains no real identifiers or secrets", () => {
  const ids = PLAYBOOK.map((topic) => topic.id);
  assert.deepEqual(ids, ["overview", "mac-setup", "credentials", "signing-and-export", "app-fixes", "screenshots", "app-store-connect", "compliance-and-legal", "publishing-pages", "troubleshooting", "next-release"]);
  assert.equal(playbookIndex().split("\n").length, ids.length);
  for (const topic of PLAYBOOK) assert.ok(topic.text.length > 400, topic.id);
  const all = PLAYBOOK.map((topic) => topic.text).join("\n");
  for (const must of ["ADMIN", "Cloud signing permission error", "GENERATE_INFOPLIST_FILE", "nested", "1206x2622", "1320x2868", "ITSAppUsesNonExemptEncryption", "database is locked", "/usr/bin/base64", "hasKeyboardFocus", "TEST_RUNNER", "Add for Review", "submit for review"]) assert.ok(new RegExp(must.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(all), must);
  for (const real of ["HV633F9Y44", "7NQ3P6AS55", "L67J56VPBG", "de52025e", "krogerjt", "5135027321", "Boudinot", "GraveyardTracker"]) assert.ok(!all.includes(real), `playbook must not contain ${real}`);
  assert.equal(playbookTopic("troubleshooting")?.id, "troubleshooting"); assert.equal(playbookTopic("x"), undefined);
});
