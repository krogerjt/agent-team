import { discoverIosProject } from "./discovery.js";

/**
 * When the host hands a finished run to Hollis for release readiness.
 * Both conditions must hold: the repository is an iOS app, and the goal is about releasing it.
 * Deliberately conservative: a goal such as "add a release notes screen" must not trigger a release stage.
 */
const RELEASE_PHRASES: RegExp[] = [
  /\bapp\s*-?\s*store\b/i,
  /\btestflight\b/i,
  /\bapp review\b/i,
  /\bready for (?:release|submission|the store|review)\b/i,
  /\brelease (?:build|candidate|readiness|checklist|to (?:the )?(?:store|public|users|production))\b/i,
  /\b(?:ship|submit|upload|publish|release)\s+(?:it|this|that|the app|the build|our app|my app|the ios app|the iphone app)\b/i,
  /\b(?:ship|submit|upload|publish)\s+(?:to|for)\s+(?:the\s+)?(?:store|apple|review|testflight)\b/i,
  /\barchive\s+(?:and|&)\s+(?:upload|export|submit)\b/i,
];

export function goalMentionsRelease(goal: string): boolean {
  return RELEASE_PHRASES.some((pattern) => pattern.test(goal));
}

/** True when the repository has an application target for iOS (platform unknown counts as iOS). */
export async function isIosApp(root: string): Promise<boolean> {
  try {
    const discovery = await discoverIosProject(root);
    const target = discovery.appTarget;
    return Boolean(target) && (target!.platform === undefined || target!.platform === "iOS");
  } catch { return false; }
}

/** AGENT_TEAM_RELEASE_STAGE=off turns the automatic hand-off off. */
export function releaseStageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AGENT_TEAM_RELEASE_STAGE ?? "").trim().toLowerCase() !== "off";
}

export async function shouldRunReleaseStage(goal: string, root: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return releaseStageEnabled(env) && goalMentionsRelease(goal) && await isIosApp(root);
}
