import type { ToolDefinition, ToolResult } from "../core/provider.js";
import { readRemoteBuildHost, readRemoteProjectSettings } from "../remote/settings.js";
import { sshScript, type RemoteScriptRunner } from "../remote/executor.js";
import { auditRelease, type AuditEvidence } from "./audit.js";
import { discoverIosProject } from "./discovery.js";
import { buildReport, type Report } from "./report.js";
import { redactDeep } from "./redact.js";
import { inspectIosReadiness } from "./readiness.js";
import { captureRunContext, runIosOperation, type OperationDeps } from "./operations.js";
import { bumpVersion, generateReleaseTemplates, screenshotRequirements, submissionChecklist, validateReleaseFiles } from "./prepare.js";
import { collectScreenshots } from "./screenshots.js";
import { playbookIndex, playbookTopic } from "./playbook.js";
import { MAINTENANCE_ACTIONS, runMaintenance, type MaintenanceAction } from "./maintenance.js";
import { readdir, readFile as readTextFile } from "node:fs/promises";
import path from "node:path";
import { runsDir } from "./store.js";
import { redactSecrets } from "./redact.js";
import { buildProgress, resumeAfterBlocker, satisfiedBlockers } from "./session.js";
import { readIosState, recordStep, type IosReleaseState } from "./store.js";
import type { Finding, IosDiscovery, OperationName, StepId } from "./types.js";

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const OPERATIONS: OperationName[] = ["generate-project", "build-simulator", "test-simulator", "build-release", "install-device", "archive", "export", "upload"];

const readTools: ToolDefinition[] = [
  { name: "ios_recent_runs", description: "List recent iOS operations with status, summary and failure class; pass id to read the (redacted) end of that run's output log. Use this to diagnose a failed or odd result instead of guessing.", parameters: schema({ id: { type: "string", description: "A run id from the list." } }) },
  { name: "ios_mac_maintenance", description: "Fixed upkeep for the Mac Build Host, limited to this tool's own folder and processes: diagnose (load, disk, Xcode, leftover jobs, running builds), clear-stale-jobs (job folders older than a day), clear-build-cache, stop-stray-builds (only builds using this tool's cache). Never touches the user's Xcode or projects. Use when builds fail with 'database is locked', the Mac is slow, or space is low.", parameters: schema({ action: { type: "string", enum: ["diagnose", "clear-stale-jobs", "clear-build-cache", "stop-stray-builds"] } }, ["action"]) },
  { name: "ios_playbook", description: "Read the iOS release runbook learned from a real submission: who does what, Mac and credential setup, signing/export/upload, app bugs seen on iOS 26, screenshots, App Store Connect fields, compliance and legal guidance, publishing pages, a symptom-to-fix troubleshooting table, and the next-release checklist. Call with no topic for the index. Read the relevant topic before a step and before diagnosing an error.", parameters: schema({ topic: { type: "string", description: "overview, mac-setup, credentials, signing-and-export, app-fixes, screenshots, app-store-connect, compliance-and-legal, publishing-pages, troubleshooting, next-release" } }) },
  { name: "ios_discover_project", description: "Inspect the iOS repository from files only: Xcode project/workspace, XcodeGen spec, app target, schemes, bundle ID, version, build number, deployment target, icons, test targets, signing and release configuration, privacy/support/App Store metadata files. Separates facts, missing items, warnings and blockers. Read-only.", parameters: schema({}) },
  { name: "ios_check_readiness", description: "Check the connected Mac for iOS releasing: macOS, Xcode 26+, command-line tools, XcodeGen when needed, simulator runtimes, xcodebuild/xcrun/altool, build Keychain, signing identities, provisioning, a physical iPhone, disk space. Returns passed/failed/pending/blocked findings with exact fixes; never secret values. Readiness is not a successful build.", parameters: schema({ physicalDeviceWanted: { type: "boolean" } }) },
  { name: "ios_release_audit", description: "Run the release-readiness audit: bundle ID, version/build, signing, icons, debug-only settings and development endpoints, test status, privacy behavior, privacy/support files, App Store metadata, export compliance, review notes, screenshots, physical-device testing. Returns machine-readable findings grouped as passed/failed/pending/blocked plus a short report. Placeholders are reported as pending user input, never as passed.", parameters: schema({}) },
  { name: "ios_release_status", description: "Show exact release progress per step (discover → readiness → … → upload; submit is always manual), the next step, and any blockers. With recheck=true, re-inspect the project/Mac and unblock steps whose blockers the user has since fixed, so work resumes where it stopped.", parameters: schema({ recheck: { type: "boolean" } }) },
  { name: "ios_screenshot_requirements", description: "List required App Store screenshot classes and pixel sizes for this app, with capture guidance (simulator and XCUITest).", parameters: schema({}) },
  { name: "ios_release_preflight", description: "Dry run of archive, export and upload: shows the exact commands, which permissions/credentials/prerequisites are missing, and what would be blocked. Signs, archives, uploads and changes nothing.", parameters: schema({}) },
];

const operationTool: ToolDefinition = {
  name: "ios_run_operation",
  description: "Run one typed iOS operation on the Mac Build Host against this exact worktree: generate-project (XcodeGen), build-simulator (unsigned), test-simulator (XCTest on an available simulator; captures summary, screenshots, diagnostics), build-release (signed), install-device (build/install/launch on a connected iPhone), archive, export (export only), upload (App Store Connect; validateOnly=true only validates). Success is reported only when the command exits 0 AND its output is verified. archive/export/build-release/install-device need the user's signing permission and upload needs the user's upload permission; you cannot grant them. Use dryRun=true to preview without touching the Mac. This tool never submits for App Review.",
  parameters: schema({ operation: { type: "string", enum: OPERATIONS }, dryRun: { type: "boolean" }, scheme: { type: "string" }, testScope: { type: "string", enum: ["unit", "ui", "all"] }, simulator: { type: "string", description: "Simulator model name, for example iPhone 17 Pro Max." }, captureScreenshots: { type: "boolean", description: "Run the UI tests that save App Store screenshots." }, validateOnly: { type: "boolean" } }, ["operation"]),
};

const prepareTool: ToolDefinition = {
  name: "ios_prepare_release",
  description: "Release preparation actions. increment-build and set-marketing-version edit literal version values (dryRun defaults to true; pass dryRun=false to write, only when asked). generate-templates creates release/ metadata, privacy-policy and support starters, review notes, export-compliance notes and a checklist without overwriting existing files; every value that needs the user is a [[REQUIRES USER INPUT]] placeholder (never invent legal text, URLs, copyright owners, pricing or Apple account details). validate-files checks that release files exist and have no placeholders. checklist returns the submission checklist. collect-screenshots turns the screenshots from the latest captureScreenshots UI-test run into opaque, correctly sized PNGs under release/screenshots/ (dry run by default).",
  parameters: schema({ action: { type: "string", enum: ["increment-build", "set-marketing-version", "generate-templates", "validate-files", "checklist", "collect-screenshots"] }, marketingVersion: { type: "string" }, dryRun: { type: "boolean" } }, ["action"]),
};

export const IOS_TOOL_NAMES = [...readTools, operationTool, prepareTool].map((tool) => tool.name);
export function isIosTool(name: string): boolean { return IOS_TOOL_NAMES.includes(name); }
export function iosTools(): ToolDefinition[] { return [...readTools, operationTool, prepareTool]; }

export interface IosToolContext {
  /** The worktree to inspect and build. */
  root: string;
  /** The original repository; per-repo settings and progress are keyed by it. */
  repo: string;
  /** True when `root` is a throwaway worktree where file edits are acceptable. */
  writable: boolean;
  runDir?: string;
  /** Test seams. */
  run?: RemoteScriptRunner;
  overrides?: Partial<OperationDeps>;
}

function evidenceFrom(state: IosReleaseState, treeHash: string, discovery: IosDiscovery): AuditEvidence {
  const passedHere = (step: StepId) => state.steps[step]?.status === "passed" && state.steps[step]?.treeHash === treeHash;
  const failedHere = (step: StepId) => state.steps[step]?.status === "failed" && state.steps[step]?.treeHash === treeHash;
  const tests = state.steps["test-simulator"], scope = tests?.scope ?? "all";
  const outcome = (step: StepId): "passed" | "failed" | undefined => passedHere(step) ? "passed" : failedHere(step) ? "failed" : undefined;
  const t = outcome("test-simulator");
  return {
    unitTests: t && (scope === "unit" || scope === "all") && discovery.testTargets.unit.length ? t : undefined,
    // UI tests may skip themselves in a plain run, so only an explicit UI run counts as UI evidence.
    uiTests: t && scope === "ui" && discovery.testTargets.ui.length ? t : undefined,
    simulatorBuild: outcome("build-simulator"),
    deviceTest: outcome("install-device"),
    lastUploadedBuild: state.lastUpload && state.lastUpload.marketingVersion === discovery.appTarget?.marketingVersion ? state.lastUpload.buildNumber : undefined,
  };
}

async function operationDeps(ctx: IosToolContext): Promise<OperationDeps> {
  return { repo: ctx.repo, host: await readRemoteBuildHost(), project: await readRemoteProjectSettings(ctx.repo), settings: (await readIosState(ctx.repo)).settings, state: await readIosState(ctx.repo), run: ctx.run, ...ctx.overrides };
}

function done(value: unknown, isError = false): ToolResult {
  // Redact the values, not the serialized text: scrubbing JSON text can eat quotes and commas and corrupt it.
  return { content: JSON.stringify(redactDeep(value)).slice(0, 60_000), isError };
}

async function note(ctx: IosToolContext, step: StepId, report: Report<unknown>, treeHash: string): Promise<void> {
  const status = report.counts.blocked ? "blocked" : report.counts.failed ? "failed" : "passed";
  await recordStep(ctx.repo, {
    step, status, at: new Date().toISOString(), treeHash, summary: report.text.split("\n")[0],
    ...(status === "passed" ? {} : { blockers: report.findings.filter((finding) => finding.status === "failed" || finding.status === "blocked").slice(0, 8).map((finding) => ({ id: finding.id, remedy: finding.remedy ?? finding.detail, kind: finding.needsUserInput ? "user-input" as const : "environment" as const })) }),
  });
}

async function readiness(ctx: IosToolContext, discovery: IosDiscovery, physicalDeviceWanted = false) {
  const deps = await operationDeps(ctx);
  return inspectIosReadiness(deps.host, discovery, deps.project.setupCommand, { run: ctx.run ?? sshScript }, physicalDeviceWanted);
}

async function recentRuns(ctx: IosToolContext, id?: string): Promise<ToolResult> {
  const base = runsDir(ctx.repo);
  if (id) {
    if (!/^[A-Za-z0-9._-]{4,120}$/.test(id)) throw new Error("That is not a run id from ios_recent_runs.");
    const log = await readTextFile(path.join(base, id, "output.log"), "utf8").catch(() => undefined);
    const result = await readTextFile(path.join(base, id, "result.json"), "utf8").catch(() => undefined);
    if (!log && !result) return { content: "No such run.", isError: true };
    return done({ id, output_tail: redactSecrets((log ?? "").slice(-6000)), result: result ? (() => { try { const { output: _omit, ...rest } = JSON.parse(result) as Record<string, unknown>; return rest; } catch { return undefined; } })() : undefined });
  }
  const names = (await readdir(base).catch(() => [] as string[])).filter((name) => name !== "artifacts").sort().reverse().slice(0, 10);
  const runs = [];
  for (const name of names) {
    try {
      const record = JSON.parse(await readTextFile(path.join(base, name, "result.json"), "utf8")) as { operation?: string; status?: string; summary?: string; failureClass?: string; context?: { at?: string } };
      runs.push({ id: name, operation: record.operation, status: record.status, failureClass: record.failureClass, summary: record.summary, at: record.context?.at });
    } catch { /* skip unreadable record */ }
  }
  return done({ runs });
}

export async function executeIosTool(name: string, args: Record<string, unknown>, ctx: IosToolContext): Promise<ToolResult> {
  if (!isIosTool(name)) throw new Error(`Tool not available: ${name}`);
  if (name === "ios_playbook") {
    const topic = typeof args.topic === "string" ? playbookTopic(args.topic.trim().toLowerCase()) : undefined;
    if (topic) return { content: JSON.stringify({ topic: topic.id, title: topic.title, text: topic.text }) };
    return { content: JSON.stringify({ topics: playbookIndex(), note: typeof args.topic === "string" && args.topic ? `Unknown topic "${args.topic}".` : "Pass topic to read one." }), isError: Boolean(args.topic) };
  }
  if (name === "ios_mac_maintenance") {
    const action = String(args.action) as MaintenanceAction;
    if (!MAINTENANCE_ACTIONS.includes(action)) throw new Error(`Unknown maintenance action: ${args.action}`);
    const result = await runMaintenance(action, (await operationDeps(ctx)).host, ctx.run);
    return done(result, !result.ok);
  }
  if (name === "ios_recent_runs") return recentRuns(ctx, typeof args.id === "string" ? args.id : undefined);
  const discovery = await discoverIosProject(ctx.root);
  const context = await captureRunContext(ctx.root);

  if (name === "ios_discover_project") {
    const report = buildReport("iOS project discovery", [...discovery.blockers, ...discovery.missing, ...discovery.warnings], { facts: discovery.facts, targets: discovery.targets, schemes: discovery.schemes });
    await recordStep(ctx.repo, { step: "discover", status: discovery.blockers.length ? "blocked" : "passed", at: new Date().toISOString(), treeHash: context.treeHash, summary: discovery.blockers[0]?.detail ?? `Found ${discovery.appTarget?.name ?? "no app target"}`, ...(discovery.blockers.length ? { blockers: discovery.blockers.map((b) => ({ id: b.id, remedy: b.remedy ?? b.detail, kind: "user-input" as const })) } : {}) });
    const factLines = Object.entries(discovery.facts).filter(([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && !v.length)).map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
    return done({ facts: discovery.facts, targets: discovery.targets, schemes: discovery.schemes, missing: discovery.missing, warnings: discovery.warnings, blockers: discovery.blockers, report: `${report.text}\n\nDiscovered facts:\n${factLines.join("\n")}` });
  }
  if (name === "ios_check_readiness") {
    const report = await readiness(ctx, discovery, args.physicalDeviceWanted === true);
    await note(ctx, "readiness", report, context.treeHash);
    return done({ ok: report.ok, counts: report.counts, findings: report.findings, report: report.text }, !report.ok);
  }
  if (name === "ios_screenshot_requirements") return done(screenshotRequirements(discovery));
  if (name === "ios_release_audit") {
    const state = await readIosState(ctx.repo);
    const report = await auditRelease(ctx.root, discovery, evidenceFrom(state, context.treeHash, discovery));
    await note(ctx, "audit", report, context.treeHash);
    return done({ ok: report.ok, counts: report.counts, findings: report.findings, report: report.text }, !report.ok);
  }
  if (name === "ios_release_status") {
    let cleared: StepId[] = [];
    if (args.recheck === true) {
      const state = await readIosState(ctx.repo);
      const findings: Finding[] = [];
      const audit = await auditRelease(ctx.root, discovery, evidenceFrom(state, context.treeHash, discovery));
      findings.push(...audit.findings);
      const deps = await operationDeps(ctx);
      if (deps.host.enabled && deps.host.target) findings.push(...(await readiness(ctx, discovery)).findings);
      cleared = await resumeAfterBlocker(ctx.repo, satisfiedBlockers(findings, state.settings, discovery, deps.host.enabled));
    }
    const progress = buildProgress(await readIosState(ctx.repo), context.treeHash);
    return done({ next: progress.next, steps: progress.steps, blocked: progress.blocked, unblocked: cleared, report: progress.text });
  }
  if (name === "ios_release_preflight") {
    const deps = await operationDeps(ctx);
    const plans = [];
    for (const operation of ["archive", "export", "upload"] as const) plans.push(await runIosOperation(ctx.root, discovery, { operation, dryRun: true }, { ...deps, persist: false }));
    return done({ mode: "dry-run: nothing signed, archived, uploaded or changed", context, plans: plans.map((plan) => ({ operation: plan.operation, status: plan.status, summary: plan.summary, commands: plan.commands, remedy: plan.remedy, failureClass: plan.failureClass })) });
  }
  if (name === "ios_prepare_release") {
    const action = String(args.action);
    const dryRun = !(ctx.writable && args.dryRun === false);
    if (action === "increment-build" || action === "set-marketing-version") {
      const result = await bumpVersion(ctx.root, discovery, action === "increment-build" ? { incrementBuild: true, dryRun } : { marketingVersion: String(args.marketingVersion ?? ""), dryRun });
      if (result.applied) await recordStep(ctx.repo, { step: "prepare", status: "passed", at: new Date().toISOString(), summary: `Version now ${result.marketingVersion?.to ?? discovery.appTarget?.marketingVersion} (${result.buildNumber?.to ?? discovery.appTarget?.buildNumber})`, treeHash: (await captureRunContext(ctx.root)).treeHash });
      return done({ ...result, changes: result.changes.map((change) => ({ file: change.file })), note: dryRun ? (ctx.writable ? "Dry run. Pass dryRun=false to write." : "Read-only workspace: nothing was written.") : "Written to the worktree; review and merge as usual." });
    }
    if (action === "generate-templates") {
      const result = await generateReleaseTemplates(ctx.root, discovery, dryRun);
      if (!dryRun) await recordStep(ctx.repo, { step: "prepare", status: "passed", at: new Date().toISOString(), summary: `Created ${result.created.length} release template(s); user input still required`, treeHash: context.treeHash });
      return done({ ...result, next: "Fill every [[REQUIRES USER INPUT]] placeholder yourself; the agent cannot supply legal, URL, pricing, copyright or account details." });
    }
    if (action === "validate-files") {
      const findings = await validateReleaseFiles(ctx.root, discovery);
      const report = buildReport("Release files", findings);
      return done({ ok: report.ok && report.counts.pending === 0, counts: report.counts, findings, report: report.text });
    }
    if (action === "collect-screenshots") {
      const result = await collectScreenshots(ctx.repo, ctx.root, { dryRun });
      return done({ ...result, note: dryRun ? (ctx.writable ? "Dry run. Pass dryRun=false to write." : "Read-only workspace: nothing was written.") : "Written to release/screenshots/. Review them, then commit." });
    }
    if (action === "checklist") {
      const audit = await auditRelease(ctx.root, discovery, evidenceFrom(await readIosState(ctx.repo), context.treeHash, discovery));
      return done({ checklist: submissionChecklist(discovery, audit.findings.filter((finding) => finding.status !== "passed").map((finding) => `${finding.status.toUpperCase()}: ${finding.title} — ${finding.detail}`)) });
    }
    throw new Error(`Unknown prepare action: ${action}`);
  }
  // ios_run_operation
  const operation = String(args.operation) as OperationName;
  if (!OPERATIONS.includes(operation)) throw new Error(`Unknown operation: ${operation}`);
  const result = await runIosOperation(ctx.root, discovery, { operation, dryRun: args.dryRun === true, scheme: typeof args.scheme === "string" ? args.scheme : undefined, testScope: args.testScope as "unit" | "ui" | "all" | undefined, simulator: typeof args.simulator === "string" ? args.simulator : undefined, captureScreenshots: args.captureScreenshots === true, validateOnly: args.validateOnly === true }, await operationDeps(ctx));
  return done(result, result.status === "failed" || result.status === "blocked");
}
