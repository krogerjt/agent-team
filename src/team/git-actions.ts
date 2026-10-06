import path from "node:path";
import { createBranchWorktree, git, resolveCleanRepo } from "../coding/git.js";
import { runChecks } from "../coding/checks.js";
import { stopPreview } from "../preview/runtime.js";
import { isWebProject } from "./workflow.js";
import { loadState, logEvent, saveState, type TeamRunState } from "./state.js";

export interface ChangedFile { path: string; status: string; previousPath?: string }
export interface RepositoryGitStatus { branch: string; head: string; changes: ChangedFile[]; diff: string }
const conflictStatuses = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
function secretFile(file: string): boolean { const name = path.basename(file); return name === ".env" || name.startsWith(".env.") && name !== ".env.example"; }

export async function repositoryGitStatus(repo: string): Promise<RepositoryGitStatus> {
  const raw = (await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).split("\0").filter(Boolean);
  const changes: ChangedFile[] = [];
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    const change: ChangedFile = { status: item.slice(0, 2), path: item.slice(3) };
    if (/[RC]/.test(change.status)) change.previousPath = raw[++index];
    changes.push(change);
  }
  const paths = changes.filter((change) => !secretFile(change.path) && !secretFile(change.previousPath ?? "") && change.status !== "??").map((change) => change.path);
  return { branch: await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), head: await git(repo, ["rev-parse", "HEAD"]), changes,
    diff: paths.length ? (await git(repo, ["--literal-pathspecs", "diff", "HEAD", "--no-ext-diff", "--", ...paths])).slice(0, 40_000) : "" };
}

export async function commitLocalChanges(repo: string, message: string, files: string[], expectedHead: string): Promise<RepositoryGitStatus> {
  const status = await repositoryGitStatus(repo);
  if (status.head !== expectedHead) throw new Error("The repository changed. Refresh Git status before saving.");
  if (status.changes.some((change) => conflictStatuses.has(change.status))) throw new Error("Resolve the repository's existing merge conflicts before saving.");
  if (!message.trim() || message.length > 500) throw new Error("Enter a commit message (500 characters maximum).");
  if (!files.length || files.length > 500 || files.some((file) => typeof file !== "string" || !status.changes.some((change) => change.path === file))) throw new Error("Choose files from the current change list.");
  if (files.some(secretFile)) throw new Error("Keep .env files local; they cannot be saved through the workshop.");
  const selected = [...new Set(files.flatMap((file) => { const change = status.changes.find((item) => item.path === file)!; return change.previousPath ? [file, change.previousPath] : [file]; }))];
  if (selected.some(secretFile)) throw new Error("Keep .env files local; they cannot be saved through the workshop.");
  await git(repo, ["--literal-pathspecs", "add", "--", ...selected]);
  await git(repo, ["--literal-pathspecs", "commit", "--only", "-m", message.trim(), "--", ...selected]);
  return repositoryGitStatus(repo);
}

export interface IntegrationConflict { path: string; current: string; team: string }
export interface MergeReadiness { canMerge: boolean; reasons: string[]; git: RepositoryGitStatus; conflicts: IntegrationConflict[]; integrationPath?: string; stale: boolean; stagingDirty: boolean }

export async function mergeReadiness(state: TeamRunState): Promise<MergeReadiness> {
  const status = await repositoryGitStatus(state.repo);
  const reasons: string[] = [];
  if (state.status !== "awaiting-review") reasons.push(`This run is ${state.status.replaceAll("-", " ")}; it is not ready for merge.`);
  if (status.changes.length) reasons.push(`Your repository has ${status.changes.length} unsaved file changes. Save them before merging or updating this run.`);
  const stale = status.head !== state.baseCommit;
  if (stale) reasons.push("Your repository has newer commits than this run. Update the run to include them, then review the combined changes.");
  let stagingDirty = false;
  if (!state.staging) reasons.push("No staged build exists for this run.");
  else {
    stagingDirty = Boolean(await git(state.staging.path, ["status", "--porcelain", "--untracked-files=all"]));
    if (stagingDirty) reasons.push(`The team's worktree has unsaved edits: ${state.staging.path}`);
  }
  const conflicts: IntegrationConflict[] = [];
  if (state.integration) {
    const unmerged = (await git(state.integration.worktree.path, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
    for (const file of unmerged.slice(0, 50)) {
      const version = async (stage: number) => { try { return (await git(state.integration!.worktree.path, ["show", `:${stage}:${file}`])).slice(0, 8_000); } catch { return "(File absent in this version, or content unavailable.)"; } };
      conflicts.push({ path: file, current: secretFile(file) ? "(Local environment file hidden.)" : await version(2), team: secretFile(file) ? "(Local environment file hidden.)" : await version(3) });
    }
    reasons.push(unmerged.length ? `Choose how to resolve ${unmerged.length} conflicting files in the update worktree.` : "Finish the run update and rerun its checks.");
  }
  if (state.needsPreviewReview) reasons.push("The combined interface needs a fresh Test Bench review before merging.");
  return { canMerge: reasons.length === 0, reasons, git: status, conflicts, integrationPath: state.integration?.worktree.path, stale, stagingDirty };
}

export async function updateRunToLatest(runDir: string, expectedHead: string): Promise<TeamRunState> {
  const state = await loadState(runDir);
  if (state.status !== "awaiting-review" || !state.staging) throw new Error("Only a finished run can be updated for merge.");
  if (state.integration) throw new Error("Finish the existing update first.");
  const repo = await resolveCleanRepo(state.repo);
  const head = await git(repo, ["rev-parse", "HEAD"]);
  if (head !== expectedHead) throw new Error("The repository changed. Refresh the review before updating.");
  if (head === state.baseCommit) throw new Error("This run already starts from the current repository commit.");
  if (await git(state.staging.path, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("The team's worktree has unsaved edits. Save those before updating.");
  const worktree = await createBranchWorktree(repo, `codex/update-${state.id}-${Date.now()}`, head);
  state.integration = { worktree, baseCommit: head };
  await saveState(state);
  try { await git(worktree.path, ["-c", "user.name=Agent Team", "-c", "user.email=agent-team@localhost.invalid", "merge", "--no-ff", "--no-commit", state.staging.branch]); }
  catch (error) {
    const conflicts = await git(worktree.path, ["diff", "--name-only", "--diff-filter=U"]);
    if (!conflicts) throw error;
    await logEvent(state, "host", "update-conflicts", `Resolve in ${worktree.path}: ${conflicts}`);
    return state;
  }
  return finishRunUpdate(runDir);
}

export async function resolveRunConflict(runDir: string, file: string, choice: "current" | "team"): Promise<TeamRunState> {
  const state = await loadState(runDir);
  if (!state.integration) throw new Error("No run update is in progress.");
  const root = state.integration.worktree.path;
  const conflicts = (await git(root, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0");
  if (!conflicts.includes(file) || secretFile(file)) throw new Error("Choose a current conflict file.");
  if (choice !== "current" && choice !== "team") throw new Error("Choose your repository version or the team version.");
  await git(root, ["--literal-pathspecs", "restore", `--source=${choice === "current" ? "HEAD" : "MERGE_HEAD"}`, "--staged", "--worktree", "--", file]);
  await logEvent(state, "user", "resolved-update-conflict", `${file}: kept ${choice} version`);
  return state;
}

export async function finishRunUpdate(runDir: string): Promise<TeamRunState> {
  const state = await loadState(runDir);
  if (!state.integration || !state.staging) throw new Error("No run update is in progress.");
  const { worktree, baseCommit } = state.integration;
  if (await git(worktree.path, ["diff", "--name-only", "--diff-filter=U"])) throw new Error("Resolve the remaining conflicts before finishing the update.");
  if (await git(worktree.path, ["diff", "--name-only"])) throw new Error(`Save or stage manual edits in the update worktree before continuing: ${worktree.path}`);
  if (await git(worktree.path, ["ls-files", "--others", "--exclude-standard"])) throw new Error(`Stage new files in the update worktree before continuing: ${worktree.path}`);
  let merging = false;
  try { await git(worktree.path, ["rev-parse", "--verify", "MERGE_HEAD"]); merging = true; } catch { /* merge commit already saved */ }
  if (merging || await git(worktree.path, ["diff", "--cached", "--name-only"])) await git(worktree.path, ["-c", "user.name=Agent Team", "-c", "user.email=agent-team@localhost.invalid", "commit", "-m", merging ? "Integrate reviewed run with latest repository" : "Repair updated run"]);
  const checks = await runChecks(worktree.path, { repo: state.repo, runDir: state.runDir, taskId: "integration" });
  state.integration.checks = checks;
  await saveState(state);
  if (checks.some((check) => check.status === "failed" || check.required && check.status === "missing")) return state;
  if (await git(worktree.path, ["status", "--porcelain", "--untracked-files=all"])) throw new Error(`Checks left unsaved files in the update worktree. Review and stage them before finishing: ${worktree.path}`);
  await stopPreview(state.id);
  state.integrationHistory ??= [];
  state.integrationHistory.push({ staging: state.staging, baseCommit: state.baseCommit });
  state.staging = worktree; state.baseCommit = baseCommit; state.integrationChecks = checks;
  state.integration = undefined; state.preview = undefined;
  state.needsPreviewReview = await isWebProject(worktree.path);
  await saveState(state);
  await logEvent(state, "host", "updated-for-merge", `Updated against ${baseCommit}; checks: ${checks.map((check) => `${check.name}: ${check.status}`).join(", ")}`);
  return state;
}
