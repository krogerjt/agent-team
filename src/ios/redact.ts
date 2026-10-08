/** Defense in depth: scrub anything that looks like a credential before output reaches logs, results, or model context. */
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted private key]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted token]"],
  // Values stop at quotes, commas and semicolons so redacting never eats surrounding punctuation, and a `$NAME`
  // reference to a Mac-side variable is not a secret (it is how commands are displayed).
  [/(--apiKey|--apiIssuer|--password|-p|--keychain-password)(\s+|=)(?!\$)([^\s"',;]+)/g, "$1$2[redacted]"],
  [/((?:password|passwd|secret|token|api[_-]?key|issuer[_-]?id|key[_-]?id|private[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|(?!\$)[^\s"',;]+)/gi, "$1[redacted]"],
  [/\b[A-Za-z0-9+]{60,}={0,2}(?![A-Za-z0-9+])/g, "[redacted blob]"],
];

export function redactSecrets(text: string, knownValues: string[] = []): string {
  let result = text;
  for (const value of knownValues) if (value.length >= 4) result = result.split(value).join("[redacted]");
  // Pure hex (tree hashes, commit ids) and path segments are diagnostics, not secrets.
  // Pure hex (tree hashes, commit ids) is a diagnostic, not a secret.
  for (const [pattern, replacement] of PATTERNS) result = replacement === "[redacted blob]" ? result.replace(pattern, (match) => /^[0-9a-fA-F]+$/.test(match) || !(/\d/.test(match) && /[a-z]/.test(match) && /[A-Z]/.test(match)) ? match : replacement) : result.replace(pattern, replacement);
  return result;
}

/** Redact every string inside a result object. Scrubbing the serialized JSON instead can corrupt it. */
export function redactDeep<T>(value: T, knownValues: string[] = []): T {
  if (typeof value === "string") return redactSecrets(value, knownValues) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, knownValues)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactDeep(item, knownValues)])) as T;
  return value;
}
