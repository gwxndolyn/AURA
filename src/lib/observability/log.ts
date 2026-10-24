/**
 * Structured JSON logs to stdout (one line per event). Every product run
 * carries a correlationId through jobs, builds, commands and integrations so a
 * run can be traced end to end. Never log secrets: values for keys that look
 * sensitive are redacted.
 */
import { redactValue as redact } from "@/lib/security/redact";

export function log(level: "debug" | "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) {
  if (level === "debug" && !process.env.AURA_DEBUG) return;
  if (process.env.NODE_ENV === "test" && !process.env.AURA_LOG_IN_TESTS && level !== "error") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields) as Record<string, unknown>) });
  (level === "error" ? console.error : console.log)(line);
}
