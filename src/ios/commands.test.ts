import assert from "node:assert/strict";
import { test } from "node:test";
import * as cmd from "./commands.js";
import { redactSecrets } from "./redact.js";

const container: cmd.Container = { flag: "-project", file: "Acme.xcodeproj" };
const cache = `"$HOME"/'.agent-team-builder'/cache`;

test("archive command: Release, generic iOS destination, API-key auth by reference, build keychain", () => {
  const command = cmd.archiveCommand(container, "Acme", `"$HOME"/'r'/App.xcarchive`, cache, { teamId: "ABCDE12345", useApiKey: true });
  const text = cmd.renderCommand(command);
  assert.match(text, /^'xcodebuild' '-project' 'Acme.xcodeproj' '-scheme' 'Acme' '-configuration' 'Release' '-destination' 'generic\/platform=iOS'/);
  assert.match(text, /'-authenticationKeyID' "\$ASC_KEY_ID"/); assert.match(text, /"\$ASC_KEY_PATH"/);
  assert.match(text, /'DEVELOPMENT_TEAM=ABCDE12345'/); assert.match(text, /--keychain \$AGENT_TEAM_MAC_KEYCHAIN_PATH/);
  assert.match(text, /'archive'$/);
  assert.doesNotMatch(cmd.displayCommand(command), /\$HOME|private|AuthKey/);
  assert.match(cmd.displayCommand(command), /\$ASC_KEY_ID/);
});

test("export is export-only (never uploads) and the plist carries no secrets", () => {
  const plist = cmd.exportOptionsPlist("ABCDE12345");
  assert.match(plist, /<key>method<\/key><string>app-store-connect<\/string>/);
  assert.match(plist, /<key>destination<\/key><string>export<\/string>/);
  assert.match(plist, /ABCDE12345/); assert.doesNotMatch(plist, /password|key id|issuer/i);
  const text = cmd.renderCommand(cmd.exportCommand("A", "E", "P", { useApiKey: false }));
  assert.match(text, /-exportArchive/); assert.doesNotMatch(text, /authenticationKey/);
});

test("upload uses env references for the API key and supports validate-only", () => {
  const text = cmd.renderCommand(cmd.uploadCommand(`"$HOME"/'x.ipa'`));
  assert.match(text, /'altool' '--upload-app' '-f' "\$HOME"\/'x.ipa' '-t' 'ios' '--apiKey' "\$ASC_KEY_ID" '--apiIssuer' "\$ASC_ISSUER_ID"/);
  assert.match(cmd.renderCommand(cmd.uploadCommand("x", true)), /--validate-app/);
});

test("simulator build is unsigned; tests produce an xcresult and accept scoped targets", () => {
  assert.match(cmd.renderCommand(cmd.simulatorBuild(container, "Acme", cache)), /generic\/platform=iOS Simulator.*CODE_SIGNING_ALLOWED=NO/);
  const run = cmd.renderCommand(cmd.simulatorTest(container, "Acme", "platform=iOS Simulator,id=U", `"$HOME"/'j'/result.xcresult`, cache, ["AcmeTests"]));
  assert.match(run, /-resultBundlePath/); assert.match(run, /-only-testing:AcmeTests/); assert.match(run, /'test' 'CODE_SIGNING_ALLOWED=NO'$/);
});

test("arguments are validated so a scheme or path cannot inject shell", () => {
  assert.throws(() => cmd.simulatorBuild(container, "Acme; rm -rf ~", cache), /Invalid scheme/);
  assert.throws(() => cmd.simulatorBuild({ flag: "-project", file: "../evil.xcodeproj" }, "A", cache), /Invalid project path/);
  assert.throws(() => cmd.deviceBuild(container, "A", "not a udid", cache, { useApiKey: false }), /Invalid device UDID/);
  assert.throws(() => cmd.deviceLaunch("00008110-001A2B3C4D5E6F78", "bad id;"), /Invalid bundle/);
  assert.equal(cmd.renderArg("it's"), `'it'"'"'s'`);
});

const SIM = JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [{ name: "iPhone 17", udid: "AAA", isAvailable: true, state: "Shutdown" }, { name: "iPad Pro", udid: "BBB", isAvailable: true, state: "Booted" }], "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{ name: "iPhone 16", udid: "CCC", isAvailable: true, state: "Booted" }] } });
test("simulator selection prefers booted iPhones, and reports none", () => {
  assert.equal(cmd.pickSimulator(SIM), "platform=iOS Simulator,id=CCC");
  assert.equal(cmd.pickSimulator(JSON.stringify({ devices: {} })), undefined);
  assert.equal(cmd.pickSimulator("not json"), undefined);
});

test("device selection: none, single, preferred and ambiguous", () => {
  const a = { name: "Jane's iPhone", os: "18", udid: "00008110-AAAAAAAAAAAAAAAA" }, b = { name: "Spare iPhone", os: "17", udid: "00008110-BBBBBBBBBBBBBBBB" };
  assert.match(cmd.pickDevice([]).reason!, /No physical iPhone/);
  assert.equal(cmd.pickDevice([a]).device, a);
  assert.equal(cmd.pickDevice([a, b], b.udid.toLowerCase()).device, b);
  assert.match(cmd.pickDevice([a, b]).reason!, /Several devices/);
  assert.match(cmd.pickDevice([a], "00008110-CCCCCCCCCCCCCCCC").reason!, /not connected/);
  assert.equal(cmd.pickDevice([{ name: "Apple Watch", os: "11", udid: "00008110-DDDDDDDDDDDDDDDD" }, a]).device, a);
});

test("failure classification maps Apple/Xcode output to actionable classes", () => {
  const cases: Array<[string, string]> = [
    ["error: No signing certificate \"iOS Distribution\" found", "signing-identity"],
    ["error: No profiles for 'com.acme.app' were found", "provisioning"],
    ["Team \"X\" is not enrolled in the Apple Developer Program", "account-team"],
    ["Mac Build Keychain secret 'asc-key' is unavailable.", "credentials-missing"],
    ["Authentication failed: invalid issuer", "authentication"],
    ["The bundle version must be higher than the previously uploaded version", "duplicate-build"],
    ["/src/A.swift:3:5: error: cannot find 'x' in scope", "compile-error"],
    ["Test Case '-[AcmeTests testA]' failed (0.1 seconds).", "test-failure"],
    ["Executed 4 tests, with 1 failures", "test-failure"],
    ["xcodegen: command not found", "missing-tool"],
    ["Could not resolve host: api.appstoreconnect.apple.com", "network"],
    ["Terminated (SIGTERM).", "timeout"],
    ["something odd", "unknown"],
  ];
  for (const [text, expected] of cases) { const r = cmd.classifyFailure(text); assert.equal(r.failureClass, expected, text); assert.ok(r.remedy.length > 10); }
});

test("real Xcode output: a locked build database is not a compile or test failure, and diagnostics survive redaction", () => {
  const locked = "error: unable to attach DB: error: accessing build database \"build.db\": database is locked Possibly there are two concurrent builds running in the same filesystem location.\nTesting cancelled because the build failed.\n** TEST FAILED **";
  assert.equal(cmd.classifyFailure(locked).failureClass, "build-cache-locked");
  assert.match(cmd.classifyFailure(locked).remedy, /pkill -f xcodebuild/);
  assert.equal(cmd.classifyFailure("Testing cancelled because the build failed.\n** TEST FAILED **").failureClass, "compile-error");
  const kept = redactSecrets(`Created project at /Users/me/.agent-team-builder/jobs/97c083ac250949899a90b80a98800d6c/source/GraveyardTracker.xcodeproj\ntree ${"a1b2c3d4".repeat(8)}`);
  assert.match(kept, /GraveyardTracker\.xcodeproj/); assert.match(kept, /a1b2c3d4a1b2c3d4/);
});

test("redaction removes keys, tokens, issuer ids and known values", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----";
  const out = redactSecrets(`key:\n${pem}\nxcrun altool --apiKey ABC123DEF4 --apiIssuer 69a6de70-03db-47e3-e053-5b8c7c11a4d1\npassword=hunter22\ntoken: eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJhYmMifQ.c2lnbmF0dXJlc2lnbmF0dXJl\nvalue topsecretvalue here`, ["topsecretvalue"]);
  for (const leaked of ["MIGTAgEAMBMG", "ABC123DEF4", "69a6de70", "hunter22", "eyJhbGci", "topsecretvalue"]) assert.ok(!out.includes(leaked), leaked);
});
