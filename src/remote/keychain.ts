export const DEFAULT_BUILD_KEYCHAIN_PATH = "~/Library/Keychains/agent-team.keychain-db";
export const BUILD_KEYCHAIN_CONFIG_FILE = "~/.agent-team/mac-build-host.env";
export const BUILD_KEYCHAIN_TIMEOUT_SECONDS = 900;

function quote(value: string): string { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }

/** Trusted, Mac-local setup loaded by every unattended SSH operation. */
export function buildKeychainShell(): string {
  return `
set -e
umask 077
AGENT_TEAM_MAC_KEYCHAIN_CONFIG="\${AGENT_TEAM_MAC_KEYCHAIN_CONFIG:-\$HOME/.agent-team/mac-build-host.env}"
if [ -f "\$AGENT_TEAM_MAC_KEYCHAIN_CONFIG" ]; then . "\$AGENT_TEAM_MAC_KEYCHAIN_CONFIG"; fi
AGENT_TEAM_MAC_KEYCHAIN_PATH="\${AGENT_TEAM_MAC_KEYCHAIN_PATH:-\$HOME/Library/Keychains/agent-team.keychain-db}"
if [ ! -f "\$AGENT_TEAM_MAC_KEYCHAIN_PATH" ]; then
  printf '%s\\n' 'Agent Team Build Keychain is missing. Initialize ~/Library/Keychains/agent-team.keychain-db on the Mac.' >&2
  exit 20
fi
if [ -z "\${AGENT_TEAM_MAC_KEYCHAIN_PASSWORD:-}" ]; then
  printf '%s\\n' 'AGENT_TEAM_MAC_KEYCHAIN_PASSWORD is not configured on the Mac. Set it in ~/.agent-team/mac-build-host.env.' >&2
  exit 21
fi
/usr/bin/security unlock-keychain -p "\$AGENT_TEAM_MAC_KEYCHAIN_PASSWORD" "\$AGENT_TEAM_MAC_KEYCHAIN_PATH" >/dev/null
/usr/bin/security set-keychain-settings -lut ${BUILD_KEYCHAIN_TIMEOUT_SECONDS} "\$AGENT_TEAM_MAC_KEYCHAIN_PATH" >/dev/null
`.trim();
}

export function keychainHealthScript(): string {
  return `${buildKeychainShell()}
if ! /usr/bin/security dump-keychain "\$AGENT_TEAM_MAC_KEYCHAIN_PATH" >/dev/null 2>&1; then
  printf '%s\\n' 'The Agent Team Build Keychain could not be read after unlocking.' >&2
  exit 22
fi
printf 'KEYCHAIN\\tunlocked\\n'
`;
}

export function keychainSecretLookup(name: string): string {
  return `/usr/bin/security find-generic-password -w -a ${quote(name)} -s 'com.openai.agent-team.remote-build' "\$AGENT_TEAM_MAC_KEYCHAIN_PATH"`;
}

export function keychainSecretStore(name: string, value: string): string {
  // macOS `security` stops parsing options at the first positional argument, so the keychain path must come last
  // and the password must be passed to -w (a trailing bare -w only prompts, and only when no keychain is named).
  return `printf '%s\\n' ${quote(value)} | { V="$(cat)"; /usr/bin/security add-generic-password -U -a ${quote(name)} -s 'com.openai.agent-team.remote-build' -w "$V" "\$AGENT_TEAM_MAC_KEYCHAIN_PATH" >/dev/null; }`;
}

export function keychainRedactionScript(variable: string): string {
  return `perl -0pe 's/\\Q\$ENV{${variable}}\\E/[redacted]/g'`;
}

/**
 * Print `file` with every named Mac-side secret replaced by [redacted]. The file must be the argument of the FIRST
 * perl in the pipeline: a perl without a file reads stdin, which for `zsh -s` scripts is the script itself.
 */
export function keychainRedactionPipeline(variables: string[], file = `"$output"`): string {
  if (!variables.length) return `cat ${file}`;
  const [first, ...rest] = variables;
  return [`${keychainRedactionScript(first)} ${file}`, ...rest.map((variable) => keychainRedactionScript(variable))].join(" | ");
}
