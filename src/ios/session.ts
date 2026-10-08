import { readIosState, updateIosState, type IosReleaseSettings, type IosReleaseState } from "./store.js";
import type { Finding, IosDiscovery, StepId, StepRecord, StepStatus } from "./types.js";

export const STEP_ORDER: StepId[] = ["discover", "readiness", "prepare", "generate-project", "build-simulator", "test-simulator", "audit", "build-release", "install-device", "archive", "export", "upload", "submit"];
/** Steps that only count once something has been attempted; they never hold up `next`. */
const OPTIONAL: StepId[] = ["prepare", "generate-project", "build-release", "install-device"];
/** Passed results in this chain only count for the exact tree they were built from. */
const TREE_BOUND: StepId[] = ["archive", "export"];

export interface ProgressStep { step: StepId; status: StepStatus | "stale"; summary: string; at?: string; blockers?: StepRecord["blockers"] }
export interface ProgressView {
  steps: ProgressStep[];
  next?: StepId;
  blocked: Array<{ step: StepId; blockers: NonNullable<StepRecord["blockers"]> }>;
  text: string;
}

export function buildProgress(state: Pick<IosReleaseState, "steps">, currentTreeHash?: string): ProgressView {
  const steps: ProgressStep[] = STEP_ORDER.map((step) => {
    if (step === "submit") return { step, status: "manual", summary: "Submitting for App Review is never automated. Do it yourself in App Store Connect after upload processing finishes." };
    const record = state.steps[step];
    if (!record) return { step, status: "pending", summary: "Not run yet." };
    const stale = record.status === "passed" && TREE_BOUND.includes(step) && currentTreeHash !== undefined && record.treeHash !== currentTreeHash;
    return { step, status: stale ? "stale" : record.status, summary: stale ? `${record.summary} (the code has changed since; run it again)` : record.summary, at: record.at, blockers: record.blockers };
  });
  const incomplete = (item: ProgressStep) => !["passed", "manual", "skipped"].includes(item.status) && !(OPTIONAL.includes(item.step) && item.status === "pending");
  const next = steps.find(incomplete)?.step;
  const blocked = steps.filter((item) => item.status === "blocked" && item.blockers?.length).map((item) => ({ step: item.step, blockers: item.blockers! }));
  const mark: Record<string, string> = { passed: "✔", failed: "✘", blocked: "■", pending: "·", stale: "↻", manual: "☞", skipped: "–" };
  const lines = steps.map((item) => `${mark[item.status]} ${item.step}: ${item.status}${item.summary ? ` — ${item.summary}` : ""}`);
  for (const entry of blocked) for (const blocker of entry.blockers) lines.push(`  Blocked at ${entry.step} (${blocker.kind}): ${blocker.remedy}`);
  lines.push(next ? `Next: ${next}` : "All automatable steps are complete.");
  return { steps, next, blocked, text: lines.join("\n") };
}

/** Finding/permission ids that are satisfied right now. Used to decide which blocked steps may be retried. */
export function satisfiedBlockers(findings: Finding[], settings: IosReleaseSettings, discovery?: Pick<IosDiscovery, "appTarget">, hostEnabled = false): Set<string> {
  const ids = new Set(findings.filter((finding) => finding.status === "passed").map((finding) => finding.id));
  if (settings.permissions.signing) ids.add("permission-signing");
  if (settings.permissions.upload) ids.add("permission-upload");
  if (settings.teamId || discovery?.appTarget?.developmentTeam) ids.add("team-id");
  if (settings.apiKey) ids.add("asc-api-key");
  if (hostEnabled) ids.add("host");
  const environmentIds = ["macos", "xcode-version", "command-line-tools", "xcodebuild", "xcrun", "upload-tool", "simulator-runtime", "keychain-access", "disk"];
  const readinessSeen = findings.some((finding) => environmentIds.includes(finding.id));
  if (readinessSeen && environmentIds.every((id) => !findings.some((finding) => finding.id === id && finding.status !== "passed"))) { ids.add("environment"); ids.add("tooling"); }
  return ids;
}

/** Move blocked steps whose blockers are all resolved back to pending so work can continue. Pure over `steps`. */
export function resumeBlockedSteps(steps: IosReleaseState["steps"], satisfied: Set<string>, at = new Date().toISOString()): StepId[] {
  const cleared: StepId[] = [];
  for (const record of Object.values(steps)) {
    if (!record || record.status !== "blocked" || !record.blockers?.length) continue;
    if (record.blockers.every((blocker) => satisfied.has(blocker.id))) {
      record.status = "pending"; record.at = at; record.summary = `Unblocked (${record.blockers.map((blocker) => blocker.id).join(", ")}); ready to run again.`; record.blockers = undefined;
      cleared.push(record.step);
    }
  }
  return cleared;
}

export async function resumeAfterBlocker(repo: string, satisfied: Set<string>): Promise<StepId[]> {
  let cleared: StepId[] = [];
  await updateIosState(repo, (state) => { cleared = resumeBlockedSteps(state.steps, satisfied); });
  return cleared;
}

export async function releaseProgress(repo: string, currentTreeHash?: string): Promise<ProgressView> {
  return buildProgress(await readIosState(repo), currentTreeHash);
}
