/**
 * Structured JSON logs to stdout (one line per event). Every product run
 * carries a correlationId through jobs, builds, commands and integrations so a
 * run can be traced end to end. Never log secrets: values for keys that look
 * sensitive are redacted.
 */
const SENSITIVE = /(secret|token|password|authorization|api[_-]?key|private[_-]?key|cookie)/i;

function redact(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== "object") return typeof v === "string" && /^(sk|ghp|github_pat|whsec|rk)_[A-Za-z0-9_]{8,}/.test(v) ? "[redacted]" : v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SENSITIVE.test(k) ? "[redacted]" : redact(x, depth + 1)]));
}

export function log(level: "debug" | "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) {
  if (level === "debug" && !process.env.AURA_DEBUG) return;
  if (process.env.NODE_ENV === "test" && !process.env.AURA_LOG_IN_TESTS && level !== "error") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields) as Record<string, unknown>) });
  (level === "error" ? console.error : console.log)(line);
}
