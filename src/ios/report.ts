import type { Finding, FindingStatus } from "./types.js";

export type GroupedFindings = Record<FindingStatus, Finding[]>;

export function groupFindings(findings: Finding[]): GroupedFindings {
  const groups: GroupedFindings = { passed: [], failed: [], pending: [], blocked: [] };
  for (const item of findings) groups[item.status].push(item);
  return groups;
}

export interface Report<T = unknown> {
  title: string;
  ok: boolean;
  counts: Record<FindingStatus, number>;
  findings: Finding[];
  data?: T;
  text: string;
}

/** A readiness or audit is `ok` only when nothing failed or is blocked; pending items are listed but never counted as passed. */
export function buildReport<T>(title: string, findings: Finding[], data?: T): Report<T> {
  const groups = groupFindings(findings);
  const counts = { passed: groups.passed.length, failed: groups.failed.length, pending: groups.pending.length, blocked: groups.blocked.length };
  const lines = [`${title}: ${counts.passed} passed, ${counts.failed} failed, ${counts.pending} pending, ${counts.blocked} blocked`];
  const section = (label: string, items: Finding[], withRemedy: boolean) => {
    if (!items.length) return;
    lines.push("", `${label} (${items.length})`);
    for (const item of items) {
      lines.push(`- ${item.title}: ${item.detail}`);
      if (withRemedy && item.remedy) lines.push(`  Fix: ${item.remedy}${item.needsUserInput ? " [needs your input]" : ""}`);
    }
  };
  section("FAILED", groups.failed, true);
  section("BLOCKED", groups.blocked, true);
  section("PENDING", groups.pending, true);
  section("PASSED", groups.passed, false);
  return { title, ok: counts.failed === 0 && counts.blocked === 0, counts, findings, data, text: lines.join("\n") };
}
