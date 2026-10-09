import { quote, sshScript, type RemoteScriptRunner } from "../remote/executor.js";
import type { RemoteBuildHost } from "../remote/settings.js";
import { redactSecrets } from "./redact.js";

/**
 * Fixed, typed upkeep for the Mac Build Host. Nothing here takes free-form input: each action is a constant script
 * that only touches the tool's own folder (host.root under $HOME) or processes that mention that folder. The user's
 * own Xcode, projects and files are never read or changed.
 */
export type MaintenanceAction = "diagnose" | "clear-stale-jobs" | "clear-build-cache" | "stop-stray-builds";
export const MAINTENANCE_ACTIONS: MaintenanceAction[] = ["diagnose", "clear-stale-jobs", "clear-build-cache", "stop-stray-builds"];

export function maintenanceScript(action: MaintenanceAction, hostRoot: string): string {
  const root = `"$HOME"/${quote(hostRoot)}`;
  const head = `set +e\nR=${root}\n`;
  switch (action) {
    case "diagnose": return `${head}
printf 'LOAD\\t%s\\n' "$(uptime | sed 's/.*load averages*: //')"
printf 'DISK_FREE_GB\\t%s\\n' "$(df -Pk "$HOME" 2>/dev/null | tail -1 | awk '{print int($4/1048576)}')"
printf 'XCODE_SELECT\\t%s\\n' "$(xcode-select -p 2>/dev/null)"
printf 'XCODE\\t%s\\n' "$(xcodebuild -version 2>/dev/null | tr '\\n' ' ')"
printf 'JOB_FOLDERS\\t%s\\n' "$(ls -1 "$R/jobs" 2>/dev/null | wc -l | tr -d ' ')"
printf 'JOBS_SIZE\\t%s\\n' "$(du -sh "$R/jobs" 2>/dev/null | awk '{print $1}')"
printf 'BUILD_CACHE_SIZE\\t%s\\n' "$(du -sh "$R/cache" 2>/dev/null | awk '{print $1}')"
printf 'RELEASE_FOLDERS\\t%s\\n' "$(ls -1 "$R/releases" 2>/dev/null | wc -l | tr -d ' ')"
printf 'BUILD_PROCESSES\\t%s\\n' "$(pgrep -fl 'xcodebuild|XCBBuildService|SWBBuildService' | cut -c1-110 | tr '\\n' ';')"
printf 'CRASH_REPORTS_LAST_DAY\\t%s\\n' "$(find "$HOME/Library/Logs/DiagnosticReports" -name '*.ips' -mtime -1 2>/dev/null | wc -l | tr -d ' ')"
`;
    case "clear-stale-jobs": return `${head}
before=$(ls -1 "$R/jobs" 2>/dev/null | wc -l | tr -d ' ')
find "$R/jobs" -mindepth 1 -maxdepth 1 -type d -mtime +0 -exec rm -rf {} + 2>/dev/null
after=$(ls -1 "$R/jobs" 2>/dev/null | wc -l | tr -d ' ')
printf 'JOB_FOLDERS_BEFORE\\t%s\\nJOB_FOLDERS_AFTER\\t%s\\nNOTE\\tOnly job folders older than a day were removed.\\n' "$before" "$after"
`;
    case "clear-build-cache": return `${head}
if pgrep -f "$R/cache/DerivedData" >/dev/null 2>&1; then printf 'REFUSED\\tA build is using the cache right now. Run stop-stray-builds first if it is stuck.\\n'; exit 0; fi
rm -rf "$R/cache/DerivedData"
printf 'CLEARED\\tbuild cache (the next build will be slower)\\n'
`;
    case "stop-stray-builds": return `${head}
count=$(pgrep -f "$R/cache/DerivedData" 2>/dev/null | wc -l | tr -d ' ')
pkill -f "$R/cache/DerivedData" 2>/dev/null
sleep 1
left=$(pgrep -f "$R/cache/DerivedData" 2>/dev/null | wc -l | tr -d ' ')
printf 'STOPPED\\t%s process(es) using the build cache of this tool\\nREMAINING\\t%s\\nNOTE\\tOther builds, including your own Xcode, were not touched.\\n' "$count" "$left"
`;
  }
}

export function parseMaintenance(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab > 0 && /^[A-Z_]+$/.test(line.slice(0, tab))) values[line.slice(0, tab)] = redactSecrets(line.slice(tab + 1).trim());
  }
  return values;
}

export async function runMaintenance(action: MaintenanceAction, host: RemoteBuildHost, run: RemoteScriptRunner = sshScript): Promise<{ ok: boolean; action: MaintenanceAction; values: Record<string, string>; hints: string[] }> {
  if (!MAINTENANCE_ACTIONS.includes(action)) throw new Error(`Unknown maintenance action: ${action}`);
  if (!host.enabled || !host.target) return { ok: false, action, values: {}, hints: ["No Mac Build Host is enabled. Open Workshop Options → Mac Build Host."] };
  const result = await run(host, maintenanceScript(action, host.root), 60_000, 100_000);
  const values = parseMaintenance(result.output);
  const hints: string[] = [];
  if (action === "diagnose") {
    const load = Number((values.LOAD ?? "").split(/[\s,]+/)[0]);
    if (load > 20) hints.push(`Load average is ${load}: a build or simulator is still running or hung. Consider stop-stray-builds, or wait.`);
    if ((values.BUILD_PROCESSES ?? "").trim()) hints.push("Build processes are running. If a build fails with 'database is locked', these hold the shared cache.");
    if (Number(values.DISK_FREE_GB) < 10) hints.push("Under 10 GB free: clear-stale-jobs and clear-build-cache, then ask the user to free space.");
    if (Number(values.JOB_FOLDERS) > 5) hints.push("Many leftover job folders: run clear-stale-jobs.");
    if (!/Xcode 2[6-9]|Xcode [3-9]\d/.test(values.XCODE ?? "")) hints.push("Xcode 26 or later is needed for App Store uploads (see the playbook, mac-setup).");
  }
  return { ok: result.code === 0 && !values.REFUSED, action, values, hints };
}
