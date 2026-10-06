import assert from "node:assert/strict";
import { test } from "node:test";
import { testRemoteBuildHost, type RemoteScriptRunner } from "./executor.js";
import { buildKeychainShell, DEFAULT_BUILD_KEYCHAIN_PATH, keychainHealthScript, keychainRedactionScript, keychainSecretLookup } from "./keychain.js";

const host = { enabled: true, target: "builder@mac.local", root: ".agent-team-builder" };
const healthyMac = "MACOS\t15.0\nXCODE\tXcode 16.0\nSIMULATORS\t1\nTAR\t/usr/bin/tar\nPOD\t/usr/local/bin/pod\nBUNDLE\t/usr/local/bin/bundle\nDISK\t20000000\n";

test("build Keychain scripts use the dedicated default and explain local setup failures", () => {
  const script = buildKeychainShell();
  assert.match(script, /agent-team\.keychain-db/);
  assert.match(script, /AGENT_TEAM_MAC_KEYCHAIN_PASSWORD is not configured/);
  assert.match(script, /Agent Team Build Keychain is missing/);
  assert.match(keychainHealthScript(), /dump-keychain/);
  assert.equal(DEFAULT_BUILD_KEYCHAIN_PATH, "~/Library/Keychains/agent-team.keychain-db");
});

test("remote readiness accepts a keychain that unlocks and can be read", async () => {
  let calls = 0;
  const run: RemoteScriptRunner = async () => calls++ === 0 ? { code: 0, output: "KEYCHAIN\tunlocked\n" } : { code: 0, output: healthyMac };
  const result = await testRemoteBuildHost(host, "pod install", run);
  assert.equal(result.ok, true);
  assert.equal(result.items.find((item) => item.name === "Agent Team Build Keychain")?.ok, true);
});

test("remote readiness reports a failed unlock without exposing configuration values", async () => {
  const password = "do-not-print-this";
  const run: RemoteScriptRunner = async () => ({ code: 21, output: "AGENT_TEAM_MAC_KEYCHAIN_PASSWORD is not configured on the Mac. Set it in ~/.agent-team/mac-build-host.env.\n" });
  const result = await testRemoteBuildHost(host, "", run);
  assert.equal(result.ok, false);
  assert.match(result.items[1].detail, /mac-build-host\.env/);
  assert.doesNotMatch(result.items[1].detail, new RegExp(password));
});

test("secret lookup is explicit and output redaction uses the Mac-side environment", () => {
  const lookup = keychainSecretLookup("ios/api-token");
  assert.match(lookup, /AGENT_TEAM_MAC_KEYCHAIN_PATH/);
  assert.doesNotMatch(lookup, /login\.keychain/);
  assert.match(keychainRedactionScript("API_TOKEN"), /ENV\{API_TOKEN\}/);
});

test("XcodeGen readiness identifies a missing generator only when the project needs it", async () => {
  const run: RemoteScriptRunner = async (_host, script) => ({ code: 0, output: script.includes("sw_vers") ? healthyMac : "KEYCHAIN\tunlocked\n" });
  const result = await testRemoteBuildHost(host, "", run, ["xcodegen"]);
  assert.equal(result.ok, false);
  assert.match(result.items.find((item) => item.name === "XcodeGen")!.detail, /brew install xcodegen/);
});
