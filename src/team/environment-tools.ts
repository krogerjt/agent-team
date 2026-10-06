import type { ToolDefinition, ToolResult } from "../core/provider.js";
import { detectChecks, runChecks, type CheckRunContext } from "../coding/checks.js";
import { testRemoteBuildHost } from "../remote/executor.js";
import { readRemoteBuildHost, readRemoteProjectSettings, suggestedSetupCommand } from "../remote/settings.js";

const parameters = { type: "object", properties: {}, required: [], additionalProperties: false };
const statusTool: ToolDefinition = {
  name: "inspect_build_environment",
  description: "Inspect detected repository checks and the saved Mac Build Host configuration, then test SSH, full Xcode, simulators, build Keychain and disk readiness. Reports missing setup with concrete instructions; never returns secret values. Piper owns environment diagnosis. This tests readiness, not a successful project build.",
  parameters,
};
const checksTool: ToolDefinition = {
  name: "run_checks",
  description: "Run the host's detected checks against this exact worktree. Apple builds/tests use the configured Mac via SSH when needed. Returns real build output and failures. Use after changing assets or code; no arbitrary command arguments are accepted.",
  parameters,
};

export function buildEnvironmentTools(writable: boolean): ToolDefinition[] {
  return writable ? [statusTool, checksTool] : [statusTool];
}

export async function executeBuildEnvironmentTool(name: string, root: string, repo: string, writable: boolean, context?: CheckRunContext): Promise<ToolResult> {
  if (name === "run_checks" && writable) {
    const checks = await runChecks(root, { ...context, repo });
    return { content: JSON.stringify(checks), isError: checks.some((check) => check.status === "failed" || check.required && check.status === "missing") };
  }
  if (name !== "inspect_build_environment") throw new Error(`Tool not available: ${name}`);
  const commands = await detectChecks(root);
  const host = await readRemoteBuildHost();
  const project = await readRemoteProjectSettings(repo);
  const readiness = host.enabled && host.target ? await testRemoteBuildHost(host, project.setupCommand, undefined, commands.map((command) => command.executable)) : undefined;
  return { content: JSON.stringify({
    checks: commands,
    macHost: host,
    project: { setupCommand: project.setupCommand, secretVariables: Object.keys(project.secrets) },
    suggestedSetupCommand: await suggestedSetupCommand(root),
    imageTools: { localPngConversion: true, imageGenerationConfigured: Boolean(process.env.OPENAI_API_KEY && process.env.AGENT_TEAM_IMAGE_MODEL) },
    readiness,
    guidance: !host.enabled || !host.target
      ? "Open Workshop Options → Mac Build Host, save the Mac SSH alias, test it, and enable the host."
      : readiness?.ok
        ? "Mac prerequisites are ready. Run the detected checks to verify the actual project; readiness alone is not a build pass."
        : "Piper should diagnose failed readiness items. Use Workshop Options → Mac Build Host to update connection and repository preparation settings. Configure secret values only through the secret UI or locally on the Mac, never in chat.",
  }) };
}
