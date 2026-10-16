import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RemoteScriptRunner } from "../remote/executor.js";
import { chooseDevice, classifySideloadFailure, deviceProbeScript, macAppPath, parseDeviceProbe, sideloadApp, sideloadScript, type SideloadTool } from "./sideload.js";
import { saveRemoteBuildHost } from "../remote/settings.js";
import { createHollisSession } from "./hollis-session.js";
import { saveIosSettings } from "./store.js";
import { executeIosTool } from "./tools.js";
import { healthyApp, host, iosRepo, withData } from "./test-helpers.js";

const DEVICECTL_JSON = JSON.stringify({ info: { outcome: "success" }, result: { devices: [
  { identifier: "A1B2C3D4-0000-0000-0000-000000000001", connectionProperties: { pairingState: "paired", tunnelState: "disconnected", transportType: "wired" }, deviceProperties: { name: "Jake's iPhone", osVersionNumber: "26.0", developerModeStatus: "enabled" }, hardwareProperties: { udid: "00008110-001A2B3C4D5E6F70", platform: "iOS", reality: "physical", marketingName: "iPhone 16 Pro" } },
  { identifier: "A1B2C3D4-0000-0000-0000-000000000002", connectionProperties: { pairingState: "paired", tunnelState: "unavailable" }, deviceProperties: { name: "Old iPad", osVersionNumber: "17.1" }, hardwareProperties: { udid: "00008020-000000000000AAAA", platform: "iOS", reality: "physical" } },
  { identifier: "A1B2C3D4-0000-0000-0000-000000000003", connectionProperties: { pairingState: "paired", tunnelState: "connected" }, deviceProperties: { name: "Watch" }, hardwareProperties: { udid: "00008301-000000000000BBBB", platform: "watchOS", reality: "physical" } },
] } });

const probeOutput = (devicectl = DEVICECTL_JSON, extra = "") => `TOOL\tdevicectl\t/Applications/Xcode.app/Contents/Developer/usr/bin/devicectl\n@@DEVICECTL_BEGIN\n${devicectl}\n@@DEVICECTL_END\nTOOL\tios-deploy\t/opt/homebrew/bin/ios-deploy\n${extra}TOOL\tlibimobiledevice\t\n`;

test("device probe: devicectl JSON is preferred, unreachable and non-iOS devices are skipped, other tools fill gaps", () => {
  const extra = "IOSDEPLOY\t[....] Found 00008110-001A2B3C4D5E6F70 (D63AP, iPhone 16 Pro, iphoneos, arm64e, 26.0, 23A341) a.k.a. 'Jake's iPhone' connected through USB.\nIOSDEPLOY\t[....] Found 00008030-0011223344556677 (J307AP, iPad Air, iphoneos, arm64e, 18.2, 22C152) a.k.a. 'Studio iPad' connected through WIFI.\n";
  const probe = parseDeviceProbe(probeOutput(DEVICECTL_JSON, extra));
  assert.deepEqual(probe.tools, { devicectl: true, "ios-deploy": true, libimobiledevice: false });
  assert.deepEqual(probe.devices.map((device) => [device.name, device.tool, device.os]), [["Jake's iPhone", "devicectl", "26.0"], ["Studio iPad", "ios-deploy", "18.2"]]);
  const idevice = parseDeviceProbe("TOOL\tdevicectl\t\nTOOL\tios-deploy\t\nTOOL\tlibimobiledevice\t/opt/homebrew/bin/ideviceinstaller\nIDEVICE\t00008110-001A2B3C4D5E6F70\tJake's iPhone\t17.5\tiPhone15,2\n");
  assert.deepEqual(idevice.devices, [{ udid: "00008110-001A2B3C4D5E6F70", name: "Jake's iPhone", os: "17.5", model: "iPhone15,2", tool: "libimobiledevice", ready: true }]);
  assert.deepEqual(parseDeviceProbe(probeOutput("not json")).devices, []);
});

test("device choice: one device is used, several need a UDID, untrusted or Developer Mode off is explained", () => {
  const one = parseDeviceProbe(probeOutput());
  assert.equal(chooseDevice(one).device?.udid, "00008110-001A2B3C4D5E6F70");
  assert.match(chooseDevice(one, { udid: "00008020-000000000000AAAA" }).reason ?? "", /not connected/);
  assert.match(chooseDevice(one, { tool: "libimobiledevice" }).reason ?? "", /not installed/);
  const two = parseDeviceProbe(probeOutput(DEVICECTL_JSON, "IOSDEPLOY\t[....] Found 00008030-0011223344556677 (J307AP, iPad Air, iphoneos, arm64e, 18.2, 22C152) a.k.a. 'Studio iPad' connected through USB.\n"));
  const several = chooseDevice(two);
  assert.match(several.reason ?? "", /Several devices/);
  assert.match(several.remedy ?? "", /--device/);
  assert.equal(chooseDevice(two, { udid: "00008030-0011223344556677" }).device?.tool, "ios-deploy");
  const untrusted = JSON.stringify({ result: { devices: [{ connectionProperties: { pairingState: "unpaired", tunnelState: "disconnected" }, deviceProperties: { name: "New iPhone" }, hardwareProperties: { udid: "00008110-0000000000000001", platform: "iOS", reality: "physical" } }] } });
  assert.match(chooseDevice(parseDeviceProbe(probeOutput(untrusted))).remedy ?? "", /Trust/);
  const devModeOff = JSON.stringify({ result: { devices: [{ connectionProperties: { pairingState: "paired", tunnelState: "disconnected" }, deviceProperties: { name: "iPhone", developerModeStatus: "disabled" }, hardwareProperties: { udid: "00008110-0000000000000002", platform: "iOS" } }] } });
  assert.match(chooseDevice(parseDeviceProbe(probeOutput(devModeOff))).remedy ?? "", /Developer Mode/);
  assert.match(chooseDevice(parseDeviceProbe("TOOL\tdevicectl\t\nTOOL\tios-deploy\t\nTOOL\tlibimobiledevice\t\n")).remedy ?? "", /brew install/);
  assert.match(chooseDevice(parseDeviceProbe(probeOutput(JSON.stringify({ result: { devices: [] } })))).reason ?? "", /No iPhone or iPad/);
});

test("generated scripts are valid shell and quote every path", () => {
  const bash = spawnSync("bash", ["-c", "true"]).status === 0;
  const scripts = [deviceProbeScript(), ...(["devicectl", "ios-deploy", "libimobiledevice"] as SideloadTool[]).map((tool) => sideloadScript(macAppPath("~/Downloads/My App's Build.ipa"), `"$HOME"/'.agent-team-builder'/jobs/x`, tool, "00008110-001A2B3C4D5E6F70", true, "n0nce"))];
  if (bash) for (const script of scripts) { const check = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }); assert.equal(check.status, 0, check.stderr); }
  assert.equal(macAppPath("~/Downloads/My App.ipa"), `"$HOME"/'Downloads/My App.ipa'`);
  assert.equal(macAppPath("/Users/jake/Build/App.app/"), `'/Users/jake/Build/App.app'`);
  assert.throws(() => macAppPath("Downloads/App.ipa"), /absolute/);
  assert.throws(() => macAppPath("~/notes.txt"), /\.ipa/);
  assert.throws(() => sideloadScript("x", "y", "devicectl", "00000; rm -rf /", false, "n"), /Invalid device UDID/);
});

test("failures name the device-side fix", () => {
  assert.equal(classifySideloadFailure("ERROR: The application could not be verified. (0xe8008015) A valid provisioning profile for this executable was not found.").failureClass, "provisioning");
  assert.match(classifySideloadFailure("Developer Mode is disabled").remedy, /Developer Mode/);
  assert.match(classifySideloadFailure("kAMDMobileImageMounterDeviceLocked").remedy, /Unlock/);
  assert.match(classifySideloadFailure("MinimumOSVersion 27.0 is higher than the device").remedy, /newer iOS/);
});

function fakeMac(installOutput: (nonce: string) => string, probe = probeOutput()): { run: RemoteScriptRunner; scripts: string[] } {
  const scripts: string[] = [];
  const run: RemoteScriptRunner = async (_host, script) => {
    scripts.push(script);
    if (script.includes("devicectl list devices")) return { code: 0, output: probe };
    const nonce = /@@([0-9a-f]{32}):EXIT/.exec(script)?.[1];
    return nonce ? { code: 0, output: installOutput(nonce) } : { code: 0, output: "" };
  };
  return { run, scripts };
}

test("sideload: copies a local .ipa, installs with devicectl, launches, and cleans up", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "sideload-"));
  try {
    const ipa = path.join(folder, "Acme.ipa");
    await writeFile(ipa, "PK");
    const uploads: string[] = [];
    const { run, scripts } = fakeMac((n) => `@@${n}:CFBundleIdentifier=com.acme.app\n@@${n}:CFBundleShortVersionString=1.2.0\n@@${n}:CFBundleVersion=7\n@@${n}:CFBundleDisplayName=Acme\n\n$ xcrun devicectl device install app\nApp installed:\n\n$ xcrun devicectl device process launch\nLaunched application with com.acme.app bundle identifier.\n@@${n}:EXIT=0\n@@${n}:INSTALLED=1\n@@${n}:LAUNCHED=1\n`);
    const result = await sideloadApp({ app: ipa, launch: true }, { host, run, uploadApp: async (_h, local, dir) => { uploads.push(local); return `${dir}/'Acme.ipa'`; }, newId: () => "job1" });
    assert.equal(result.status, "success", result.summary);
    assert.equal(result.verified, true);
    assert.equal(result.launched, true);
    assert.match(result.summary, /Installed Acme 1\.2\.0 \(7\) on Jake's iPhone \(iOS 26\.0\) with devicectl\. Launched it\./);
    assert.deepEqual(uploads, [ipa]);
    const install = scripts.find((script) => script.includes("SRC="))!;
    assert.match(install, /SRC="\$HOME"\/'\.agent-team-builder'\/jobs\/job1\/upload\/'Acme\.ipa'/);
    assert.match(install, /xcrun devicectl device install app --device '00008110-001A2B3C4D5E6F70' "\$APP"/);
    assert.match(scripts.at(-1)!, /rm -rf .*jobs\/job1/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("sideload: an exit-0 run without install confirmation, and a provisioning failure, are not successes", async () => {
  const unconfirmed = fakeMac((n) => `whatever\n@@${n}:EXIT=0\n`);
  const result = await sideloadApp({ app: "~/Acme.ipa", onMac: true }, { host, run: unconfirmed.run });
  assert.equal(result.status, "failed");
  assert.equal(result.failureClass, "verification");
  assert.equal(unconfirmed.scripts.some((script) => script.includes("SRC=\"$HOME\"/'Acme.ipa'")), true);
  const denied = fakeMac((n) => `$ xcrun devicectl device install app\nERROR: Unable to Install "Acme" (0xe8008015) A valid provisioning profile for this executable was not found.\n@@${n}:EXIT=1\n`);
  const failed = await sideloadApp({ app: "/Users/jake/Acme.ipa", onMac: true }, { host, run: denied.run });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureClass, "provisioning");
  assert.match(failed.remedy ?? "", /UDID/);
});

test("sideload: blocked without a host, a device, or a valid path; dry run touches nothing", async () => {
  const never: RemoteScriptRunner = async () => { throw new Error("must not contact the Mac"); };
  assert.match((await sideloadApp({ app: "~/A.ipa", onMac: true }, { host: { ...host, enabled: false }, run: never })).summary, /No Mac Build Host/);
  assert.equal((await sideloadApp({ app: "C:/nope/A.ipa" }, { host, run: never })).status, "blocked");
  assert.equal((await sideloadApp({ app: "~/notes.txt", onMac: true }, { host, run: never })).status, "blocked");
  assert.equal((await sideloadApp({ app: "~/A.ipa", onMac: true, udid: "bad udid" }, { host, run: never })).status, "blocked");
  const dry = await sideloadApp({ app: "~/A.ipa", onMac: true, launch: true, dryRun: true }, { host, run: never });
  assert.equal(dry.status, "dry-run");
  assert.deepEqual(dry.commands, ["xcrun devicectl device install app --device <connected device> <app>", "xcrun devicectl device process launch --device <connected device> <bundle id>"]);
  const empty = fakeMac(() => "", probeOutput(JSON.stringify({ result: { devices: [] } })));
  const none = await sideloadApp({ app: "~/A.ipa", onMac: true }, { host, run: empty.run });
  assert.equal(none.status, "blocked");
  assert.match(none.summary, /No iPhone or iPad/);
  // A saved preferred device picks between several; it is ignored when it is not connected.
  const two = probeOutput(DEVICECTL_JSON, "IOSDEPLOY\t[....] Found 00008030-0011223344556677 (J307AP, iPad Air, iphoneos, arm64e, 18.2, 22C152) a.k.a. 'Studio iPad' connected through USB.\n");
  const preferred = fakeMac((n) => `[100%] Installed package\n@@${n}:EXIT=0\n@@${n}:INSTALLED=1\n`, two);
  const viaPreferred = await sideloadApp({ app: "~/A.ipa", onMac: true }, { host, run: preferred.run, preferredUdid: "00008030-0011223344556677" });
  assert.equal(viaPreferred.status, "success", viaPreferred.summary);
  assert.equal(viaPreferred.device?.tool, "ios-deploy");
  assert.match((await sideloadApp({ app: "~/A.ipa", onMac: true }, { host, run: fakeMac(() => "", two).run, preferredUdid: "00008020-000000000000AAAA" })).summary, /Several devices/);
});

test("agent tools: Hollis lists devices and sideloads, the run is recorded, and the readiness stage refuses installs", async () => {
  const repo = await iosRepo(healthyApp());
  try {
    await withData(repo, async () => {
      const mac = fakeMac((n) => `App installed:\n@@${n}:EXIT=0\n@@${n}:INSTALLED=1\n@@${n}:CFBundleIdentifier=com.acme.app\n`);
      const ctx = { root: repo.root, repo: repo.root, writable: false, run: mac.run, uploadApp: async () => { throw new Error("on-Mac paths are not copied"); } };
      const json = (result: { content: string }) => JSON.parse(result.content);
      assert.equal((await executeIosTool("ios_list_devices", {}, ctx)).isError, true, "no host enabled yet");
      await saveRemoteBuildHost(host);
      const listed = json(await executeIosTool("ios_list_devices", {}, ctx));
      assert.match(listed.report, /Jake's iPhone \(iOS 26\.0\) 00008110-001A2B3C4D5E6F70 via devicectl/);
      await saveIosSettings(repo.root, { deviceUdid: "00008110-001A2B3C4D5E6F70" });
      const installed = json(await executeIosTool("ios_sideload_app", { app: "~/Builds/Acme.ipa", onMac: true }, ctx));
      assert.equal(installed.status, "success", installed.summary);
      const runs = json(await executeIosTool("ios_recent_runs", {}, ctx)).runs;
      assert.equal(runs[0].operation, "sideload");
      await assert.rejects(() => executeIosTool("ios_sideload_app", {}, ctx), /\.ipa/);
      const readiness = createHollisSession({ repo: repo.root, root: repo.root, writable: false, mode: "readiness", run: mac.run });
      const refused = await readiness.execute("ios_sideload_app", { app: "~/Builds/Acme.ipa", onMac: true });
      assert.equal(refused?.isError, true); assert.match(refused!.content, /readiness stage/);
    });
  } finally { await repo.cleanup(); }
});
