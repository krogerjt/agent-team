import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateIosReadiness, inspectIosReadiness, parseReadinessProbe, readinessProbeScript, xcodeMajor } from "./readiness.js";
import { host } from "./test-helpers.js";

const GOOD = [
  "MACOS\t15.1", "XCODE\tXcode 26.0.1 Build version 17A400 ", "CLT\t/Applications/Xcode.app/Contents/Developer", "XCODEBUILD\t/usr/bin/xcodebuild", "XCRUN\t/usr/bin/xcrun",
  "XCODEGEN\t/opt/homebrew/bin/xcodegen", "POD\t", "BUNDLE\t", "ALTOOL\t/Applications/Xcode.app/Contents/Developer/usr/bin/altool", "RUNTIMES\t1", "SIMULATORS\t6",
  "IDENTITIES\t\"Apple Distribution: Acme Ltd (ABCDE12345)\";\"Apple Development: Jane Doe (XYZ)\";",
  "PROFILES\t2", "DEVICE\tJane's iPhone (18.1) (00008110-001A2B3C4D5E6F78)", "DISK\t52428800",
].join("\n");
const byId = (findings: ReturnType<typeof evaluateIosReadiness>) => Object.fromEntries(findings.map((f) => [f.id, f]));

test("a ready Mac passes every required item and sees the physical iPhone", () => {
  const values = parseReadinessProbe(GOOD);
  assert.equal(values.devices.length, 1);
  assert.deepEqual(values.devices[0], { name: "Jane's iPhone", os: "18.1", udid: "00008110-001A2B3C4D5E6F78" });
  const f = byId(evaluateIosReadiness(values, { requiresXcodeGen: true }));
  for (const id of ["macos", "xcode-version", "command-line-tools", "xcodebuild", "xcrun", "upload-tool", "xcodegen", "simulator-runtime", "keychain-access", "signing-distribution", "signing-development", "provisioning", "physical-device", "disk"]) assert.equal(f[id].status, "passed", id);
});

test("old Xcode, missing tools, no signing and no device give exact fixes and correct severities", () => {
  const values = parseReadinessProbe("MACOS\t14.5\nXCODE\tXcode 15.4 Build version 15F31d \nCLT\t\nRUNTIMES\t0\nSIMULATORS\t0\nIDENTITIES\t\nPROFILES\t0\nDISK\t1000\n");
  const f = byId(evaluateIosReadiness(values, { requiresXcodeGen: true, usesCocoaPods: true }));
  assert.equal(f["xcode-version"].status, "failed"); assert.match(f["xcode-version"].remedy!, /Upgrade Xcode to 26/);
  assert.equal(f["command-line-tools"].status, "failed");
  assert.equal(f.xcodegen.status, "failed"); assert.match(f.xcodegen.remedy!, /brew install xcodegen/);
  assert.equal(f.cocoapods.status, "failed");
  assert.equal(f["simulator-runtime"].status, "failed");
  assert.equal(f["signing-distribution"].status, "failed"); assert.match(f["signing-distribution"].remedy!, /Distribution certificate/);
  assert.equal(f["signing-development"].status, "pending");
  assert.equal(f.provisioning.status, "pending");
  assert.equal(f["physical-device"].status, "pending");
  assert.equal(f.disk.status, "failed");
  assert.equal(byId(evaluateIosReadiness(values, { physicalDeviceWanted: true }))["physical-device"].status, "failed");
  assert.equal(xcodeMajor("Xcode 26.1"), 26); assert.equal(xcodeMajor("nonsense"), undefined);
});

test("XcodeGen is only demanded when the project needs it", () => {
  const f = byId(evaluateIosReadiness(parseReadinessProbe(GOOD)));
  assert.equal(f.xcodegen, undefined);
});

test("the probe never reads or prints secret material", () => {
  const script = readinessProbeScript();
  assert.doesNotMatch(script, /find-generic-password|dump-keychain|export-key|PASSWORD=/);
  assert.match(script, /find-identity -v -p codesigning/);
});

test("end to end: reuses the host checks, blocks on a broken connection, and reports probe results", async () => {
  const base = async () => ({ ok: true, target: "build-mac", items: [{ name: "SSH connection", ok: true, detail: "build-mac" }, { name: "Agent Team Build Keychain", ok: true, detail: "Exists" }] });
  const calls: string[] = [];
  const report = await inspectIosReadiness(host, { needsXcodeGen: true, facts: {} }, "", { run: async (_h, script) => { calls.push(script); return { code: 0, output: GOOD }; }, testHost: base as never });
  assert.equal(report.ok, true, report.text);
  assert.equal(calls.length, 1);
  const broken = await inspectIosReadiness(host, { needsXcodeGen: false, facts: {} }, "", { run: async () => { throw new Error("must not probe"); }, testHost: (async () => ({ ok: false, target: "build-mac", items: [{ name: "SSH connection", ok: false, detail: "timeout" }] })) as never });
  assert.equal(broken.ok, false); assert.equal(broken.counts.blocked, 1);
  const disabled = await inspectIosReadiness({ ...host, enabled: false }, { needsXcodeGen: false, facts: {} }, "", { run: async () => ({ code: 0, output: "" }) });
  assert.equal(disabled.counts.blocked, 1); assert.match(disabled.findings[0].remedy!, /Mac Build Host/);
});
