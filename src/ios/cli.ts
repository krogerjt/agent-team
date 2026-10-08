import "dotenv/config";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { git } from "../coding/git.js";
import { executeIosTool } from "./tools.js";
import { readIosState, saveIosSettings, setIosPermission } from "./store.js";

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
  prepare <increment-build|set-marketing-version|generate-templates|validate-files|checklist> [--apply] [--marketing-version 1.2.0]
  run <generate-project|build-simulator|test-simulator|build-release|install-device|archive|export|upload> [--dry-run] [--scheme S] [--test-scope unit|ui|all] [--validate-only]
  settings [--team ID] [--scheme S] [--device UDID] [--api-key-id-secret N --api-issuer-secret N --api-key-secret N]
  grant <signing|upload>           YOU grant a permission; agents cannot
  revoke <signing|upload>
Submitting for App Review is never automated.`);
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
    const result = await executeIosTool("ios_run_operation", { operation: sub, dryRun: args.includes("--dry-run"), scheme: optional(args, "--scheme"), testScope: optional(args, "--test-scope"), validateOnly: args.includes("--validate-only") }, ctx);
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
