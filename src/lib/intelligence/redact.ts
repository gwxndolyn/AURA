/**
 * Redaction for anything persisted by the intelligence layer (evaluation
 * outputs, knowledge evidence, reports). Removes secrets and truncates so
 * records never carry API keys, tokens, passwords, or large source dumps.
 * Pure.
 */

const PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_\-]{6,}/g, "[REDACTED:anthropic-key]"],
  [/\bsk-[A-Za-z0-9]{16,}\b/g, "[REDACTED:api-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED:github-token]"],
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}\b/g, "[REDACTED:jwt]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
  [/((?:password|passwd|secret|api[_-]?key|token|authorization)\s*[:=]\s*)(["']?)[^\s"',;]{4,}\2/gi, "$1[REDACTED]"],
  [/(Bearer\s+)[A-Za-z0-9._\-]{8,}/g, "$1[REDACTED]"],
];

export function redact(text: string, maxLen = 2000): string {
  let out = text ?? "";
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  if (out.length > maxLen) out = out.slice(0, maxLen) + `… [truncated ${out.length - maxLen} chars]`;
  return out;
}

/** Redact every string value in a JSON-serializable object (deep). */
export function redactDeep<T>(value: T, maxLen = 2000): T {
  if (typeof value === "string") return redact(value, maxLen) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, maxLen)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, maxLen);
    return out as T;
  }
  return value;
}
