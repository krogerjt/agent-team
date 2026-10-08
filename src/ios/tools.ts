import type { ToolDefinition, ToolResult } from "../core/provider.js";
import { readRemoteBuildHost, readRemoteProjectSettings } from "../remote/settings.js";
import { sshScript, type RemoteScriptRunner } from "../remote/executor.js";
import { auditRelease, type AuditEvidence } from "./audit.js";
import { discoverIosProject } from "./discovery.js";
import { buildReport, type Report } from "./report.js";
import { redactSecrets } from "./redact.js";
import { inspectIosReadiness } from "./readiness.js";
import { captureRunContext, runIosOperation, type OperationDeps } from "./operations.js";
import { bumpVersion, generateReleaseTemplates, screenshotRequirements, submissionChecklist, validateReleaseFiles } from "./prepare.js";
import { buildProgress, resumeAfterBlocker, satisfiedBlockers } from "./session.js";
import { readIosState, recordStep, type IosReleaseState } from "./store.js";
import type { Finding, IosDiscovery, OperationName, StepId } from "./types.js";

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const OPERATIONS: OperationName[] = ["generate-project", "build-simulator", "test-simulator", "build-release", "install-device", "archive", "export", "upload"];

const readTools: ToolDefinition[] = [
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
  parameters: schema({ operation: { type: "string", enum: OPERATIONS }, dryRun: { type: "boolean" }, scheme: { type: "string" }, testScope: { type: "string", enum: ["unit", "ui", "all"] }, validateOnly: { type: "boolean" } }, ["operation"]),
};

const prepareTool: ToolDefinition = {
  name: "ios_prepare_release",
  description: "Release preparation actions. increment-build and set-marketing-version edit literal version values (dryRun defaults to true; pass dryRun=false to write, only when asked). generate-templates creates release/ metadata, privacy-policy and support starters, review notes, export-compliance notes and a checklist without overwriting existing files; every value that needs the user is a [[REQUIRES USER INPUT]] placeholder (never invent legal text, URLs, copyright owners, pricing or Apple account details). validate-files checks that release files exist and have no placeholders. checklist returns the submission checklist.",
  parameters: schema({ action: { type: "string", enum: ["increment-build", "set-marketing-version", "generate-templates", "validate-files", "checklist"] }, marketingVersion: { type: "string" }, dryRun: { type: "boolean" } }, ["action"]),
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
    uiTests: t && (scope === "ui" || scope === "all") && discovery.testTargets.ui.length ? t : undefined,
    simulatorBuild: outcome("build-simulator"),
    deviceTest: outcome("install-device"),
    lastUploadedBuild: state.lastUpload && state.lastUpload.marketingVersion === discovery.appTarget?.marketingVersion ? state.lastUpload.buildNumber : undefined,
  };
}

async function operationDeps(ctx: IosToolContext): Promise<OperationDeps> {
  return { repo: ctx.repo, host: await readRemoteBuildHost(), project: await readRemoteProjectSettings(ctx.repo), settings: (await readIosState(ctx.repo)).settings, state: await readIosState(ctx.repo), run: ctx.run, ...ctx.overrides };
}

function done(value: unknown, isError = false): ToolResult {
  return { content: redactSecrets(JSON.stringify(value)).slice(0, 60_000), isError };
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

export async function executeIosTool(name: string, args: Record<string, unknown>, ctx: IosToolContext): Promise<ToolResult> {
  if (!isIosTool(name)) throw new Error(`Tool not available: ${name}`);
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
    if (action === "checklist") {
      const audit = await auditRelease(ctx.root, discovery, evidenceFrom(await readIosState(ctx.repo), context.treeHash, discovery));
      return done({ checklist: submissionChecklist(discovery, audit.findings.filter((finding) => finding.status !== "passed").map((finding) => `${finding.status.toUpperCase()}: ${finding.title} — ${finding.detail}`)) });
    }
    throw new Error(`Unknown prepare action: ${action}`);
  }
  // ios_run_operation
  const operation = String(args.operation) as OperationName;
  if (!OPERATIONS.includes(operation)) throw new Error(`Unknown operation: ${operation}`);
  const result = await runIosOperation(ctx.root, discovery, { operation, dryRun: args.dryRun === true, scheme: typeof args.scheme === "string" ? args.scheme : undefined, testScope: args.testScope as "unit" | "ui" | "all" | undefined, validateOnly: args.validateOnly === true }, await operationDeps(ctx));
  return done(result, result.status === "failed" || result.status === "blocked");
}
