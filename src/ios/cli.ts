import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { git } from "../coding/git.js";
import { executeIosTool } from "./tools.js";
import { readIosState, saveIosSettings, saveOperationRecord, setIosPermission } from "./store.js";
import { listConnectedDevices, sideloadApp, SIDELOAD_TOOLS, type SideloadTool } from "./sideload.js";
import { readRemoteBuildHost } from "../remote/settings.js";

function value(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${flag}.`);
  return args[index + 1];
}
const optional = (args: string[], flag: string): string | undefined => args.includes(flag) ? value(args, flag) : undefined;

async function repoRoot(args: string[]): Promise<string> {
  const given = path.resolve(value(args, "--repo"));
  try { return await realpath(await git(given, ["rev-parse", "--show-toplevel"])); }
  catch { throw new Error(`'${given}' is not inside a Git repository. If the path contains spaces, wrap it in quotes: --repo "C:\\path with spaces\\repo".`); }
}

function show(content: string, asJson: boolean): void {
  const parsed = JSON.parse(content) as { report?: string };
  console.log(asJson || !parsed.report ? JSON.stringify(parsed, null, 2) : parsed.report);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const sub = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
  const args = sub ? rest.slice(1) : rest;
  const json = args.includes("--json");
  if (!command || command === "help") {
    console.log(`Usage: npm run ios -- <command> --repo <path> [--json]
  discover                         Inspect the iOS project (read-only)
  readiness [--device]             Check the Mac Build Host for iOS releasing
  audit                            Release-readiness audit
  status [--recheck]               Release progress; --recheck resumes after you fix a blocker
  preflight                        Dry run of archive/export/upload (changes nothing)
  prepare <increment-build|set-marketing-version|generate-templates|validate-files|checklist|collect-screenshots> [--apply] [--marketing-version 1.2.0]
  devices                          iPhones/iPads connected to the Mac (--repo optional)
  sideload <app.ipa|App.app> [--on-mac] [--device UDID] [--tool devicectl|ios-deploy|libimobiledevice] [--launch] [--dry-run]
                                   Install a built, signed app on the connected device (--repo optional)
  run <generate-project|build-simulator|test-simulator|build-release|install-device|archive|export|upload> [--dry-run] [--scheme S] [--test-scope unit|ui|all] [--simulator "iPhone 17 Pro Max"] [--capture-screenshots] [--validate-only]
  settings [--team ID] [--scheme S] [--device UDID] [--api-key-id-secret N --api-issuer-secret N --api-key-secret N]
  grant <signing|upload>           YOU grant a permission; agents cannot
  revoke <signing|upload>
Submitting for App Review is never automated.`);
    return;
  }
  if (command === "devices" || command === "sideload") {
    // These work on any built app, so a repository is only used for the saved preferred device and run history.
    const repo = args.includes("--repo") ? await repoRoot(args) : undefined;
    if (command === "devices") {
      const host = await readRemoteBuildHost();
      if (!host.enabled || !host.target) throw new Error("No Mac Build Host is enabled. Open Workshop Options → Mac Build Host, save the SSH alias, test it, and enable it.");
      const probe = await listConnectedDevices(host);
      if (json) console.log(JSON.stringify(probe, null, 2));
      else if (probe.error) console.log(probe.error);
      else {
        console.log(`Tools on the Mac: ${SIDELOAD_TOOLS.map((tool) => `${tool} ${probe.tools[tool] ? "yes" : "no"}`).join(", ")}`);
        console.log(probe.devices.length ? probe.devices.map((device) => `${device.name}${device.os ? ` (iOS ${device.os})` : ""}  ${device.udid}  via ${device.tool}${device.ready ? "" : `  NOT READY: ${device.note}`}`).join("\n") : "No iPhone or iPad is connected to the Mac.");
      }
      if (probe.error) process.exitCode = 1;
      return;
    }
    if (!sub) throw new Error("Pass the .ipa or .app to install: npm run ios -- sideload <path> [--on-mac] [--device UDID] [--launch]");
    const app = args.includes("--on-mac") ? sub : path.resolve(sub);
    const settings = repo ? (await readIosState(repo)).settings : undefined;
    const result = await sideloadApp({ app, onMac: args.includes("--on-mac"), udid: optional(args, "--device"), tool: optional(args, "--tool") as SideloadTool | undefined, launch: args.includes("--launch"), dryRun: args.includes("--dry-run") }, { host: await readRemoteBuildHost(), preferredUdid: settings?.deviceUdid });
    if (repo && result.status !== "dry-run") await saveOperationRecord(repo, `${new Date().toISOString().replace(/[:.]/g, "-")}-sideload-${randomUUID().slice(0, 8)}`, result).catch(() => undefined);
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log([result.summary, ...(result.remedy ? [`Fix: ${result.remedy}`] : []), ...(result.status === "failed" && result.output ? ["", result.output.slice(-3_000)] : []), ...(result.status === "dry-run" ? result.commands.map((line) => `  ${line}`) : [])].join("\n"));
    if (result.status === "failed" || result.status === "blocked") process.exitCode = 1;
    return;
  }
  const repo = await repoRoot(args);
  const ctx = { root: repo, repo, writable: args.includes("--apply") };
  if (command === "discover") return show((await executeIosTool("ios_discover_project", {}, ctx)).content, json);
  if (command === "readiness") return show((await executeIosTool("ios_check_readiness", { physicalDeviceWanted: args.includes("--device") }, ctx)).content, json);
  if (command === "audit") return show((await executeIosTool("ios_release_audit", {}, ctx)).content, json);
  if (command === "status") return show((await executeIosTool("ios_release_status", { recheck: args.includes("--recheck") }, ctx)).content, json);
  if (command === "preflight") return show((await executeIosTool("ios_release_preflight", {}, ctx)).content, true);
  if (command === "prepare") {
    if (!sub) throw new Error("Choose a prepare action.");
    return show((await executeIosTool("ios_prepare_release", { action: sub, marketingVersion: optional(args, "--marketing-version"), dryRun: !args.includes("--apply") }, ctx)).content, true);
  }
  if (command === "run") {
    if (!sub) throw new Error("Choose an operation.");
    const result = await executeIosTool("ios_run_operation", { operation: sub, dryRun: args.includes("--dry-run"), scheme: optional(args, "--scheme"), testScope: optional(args, "--test-scope"), simulator: optional(args, "--simulator"), captureScreenshots: args.includes("--capture-screenshots"), validateOnly: args.includes("--validate-only") }, ctx);
    show(result.content, true);
    if (result.isError) process.exitCode = 1;
    return;
  }
  if (command === "settings") {
    const keyId = optional(args, "--api-key-id-secret"), issuer = optional(args, "--api-issuer-secret"), key = optional(args, "--api-key-secret");
    if ((keyId || issuer || key) && !(keyId && issuer && key)) throw new Error("Pass all three of --api-key-id-secret, --api-issuer-secret and --api-key-secret (Keychain secret NAMES, never values).");
    const settings = await saveIosSettings(repo, { scheme: optional(args, "--scheme"), teamId: optional(args, "--team"), deviceUdid: optional(args, "--device"), ...(keyId && issuer && key ? { apiKey: { keyIdSecret: keyId, issuerIdSecret: issuer, privateKeySecret: key } } : {}) });
    console.log(JSON.stringify(settings, null, 2));
    return;
  }
  if (command === "grant" || command === "revoke") {
    if (sub !== "signing" && sub !== "upload") throw new Error("Choose signing or upload.");
    console.log(JSON.stringify(await setIosPermission(repo, sub, command === "grant"), null, 2));
    if (command === "grant" && sub === "upload") console.log("Upload permission granted. This still never submits the app for App Review.");
    return;
  }
  if (command === "state") { console.log(JSON.stringify((await readIosState(repo)).settings, null, 2)); return; }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
