/**
 * Secret redaction for anything that leaves AURA's trust boundary or is
 * persisted for humans: logs, audit metadata, error messages, command output
 * shown to customers, and text placed into model prompts.
 *
 * Two layers: (1) known credential shapes (provider key prefixes, JWTs, PEM
 * blocks, bearer headers, URL credentials, `NAME=value` for secret-looking
 * names); (2) exact values of secrets this process knows about (server env
 * secrets + values registered at runtime, e.g. decrypted workspace secrets).
 */

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\b(sk-ant-[A-Za-z0-9_-]{10,}|sk_(live|test)_[A-Za-z0-9]{8,}|rk_(live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|re_[A-Za-z0-9]{16,})\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted jwt]"],
  [/\b(authorization|x-api-key|cookie)\s*[:=]\s*("?)(bearer\s+|basic\s+)?[^\s"',;]+/gi, "$1: [redacted]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, "$1[redacted]@"],
  [/\b([A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"']+)/g, "$1=[redacted]"],
];

const SECRET_ENV = /(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|DATABASE_URL|WEBHOOK)/;

const g = globalThis as unknown as { auraSecretValues?: Set<string> };
function known(): Set<string> {
  if (!g.auraSecretValues) {
    g.auraSecretValues = new Set();
    for (const [k, v] of Object.entries(process.env)) if (SECRET_ENV.test(k) && v && v.length >= 8) g.auraSecretValues.add(v);
  }
  return g.auraSecretValues;
}

/** Register a secret value (e.g. a decrypted workspace secret) so it is scrubbed wherever it appears. */
export function registerSecretValue(v: string) {
  if (v && v.length >= 6) known().add(v);
}

export function redactText(input: string): string {
  if (!input) return input;
  let out = input;
  for (const v of known()) if (out.includes(v)) out = out.split(v).join("[redacted]");
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

const SENSITIVE_KEY = /(secret|token|password|authorization|api[_-]?key|private[_-]?key|cookie|ciphertext|credential)/i;

export function redactValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redactText(v);
  if (depth > 5 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactValue(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SENSITIVE_KEY.test(k) ? "[redacted]" : redactValue(x, depth + 1)]));
}
