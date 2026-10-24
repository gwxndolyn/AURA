/**
 * Resilient outbound HTTP for AURA's provider adapters (Stripe, GitHub,
 * email). One place for the operational rules:
 *
 *   timeout     every call has an explicit deadline (AbortSignal), and an
 *               optional caller signal is propagated (cancellation)
 *   retry       ONLY when repeating is safe: GET/HEAD/PUT/DELETE, or a POST
 *               that carries an Idempotency-Key. A non-idempotent POST is
 *               never retried (no duplicate payments/emails/records)
 *   which       network errors, timeouts, 429 and 5xx; never other 4xx
 *   backoff     exponential with full jitter, bounded attempts and total
 *               time; 429 honours Retry-After (capped)
 *   breaker     optional persisted circuit breaker per provider scope: an
 *               open breaker fails fast instead of hammering a broken service
 *   errors      ProviderError with a safe message (no secrets), a `kind`
 *               (timeout | rate_limited | unavailable | client_error |
 *               network | circuit_open) and `retryable`
 *
 * Failure injection (src/lib/resilience/inject.ts) hooks in here, so the
 * same code path is exercised by resilience tests.
 */
import { injected } from "./inject";

export type ProviderErrorKind = "timeout" | "rate_limited" | "unavailable" | "client_error" | "network" | "circuit_open" | "malformed";
export class ProviderHttpError extends Error {
  constructor(message: string, public kind: ProviderErrorKind, public status: number | null, public retryable: boolean, public attempts: number) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export interface ResilientOpts {
  provider: string; // scope label, e.g. "stripe"
  timeoutMs?: number;
  maxAttempts?: number;
  maxTotalMs?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  breaker?: { companyId: string } | null;
  sleep?: (ms: number) => Promise<void>;
}

const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
export function retrySafe(method: string, headers: Record<string, string> = {}) {
  return IDEMPOTENT.has(method.toUpperCase()) || Object.keys(headers).some((h) => h.toLowerCase() === "idempotency-key");
}

export function backoffMs(attempt: number, base = 200, cap = 5000, rnd = Math.random) {
  return Math.round(rnd() * Math.min(cap, base * 2 ** attempt)); // full jitter
}

export async function resilientFetch(url: string, init: RequestInit & { headers?: Record<string, string> } = {}, o: ResilientOpts) {
  const method = (init.method ?? "GET").toUpperCase();
  const safe = retrySafe(method, init.headers ?? {});
  const maxAttempts = safe ? Math.min(Math.max(o.maxAttempts ?? 3, 1), 6) : 1;
  const started = Date.now();
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const scope = `provider:${o.provider}`;
  if (o.breaker) {
    const { isOpen } = await import("@/lib/runtime/breaker");
    if (await isOpen(o.breaker.companyId, scope)) throw new ProviderHttpError(`${o.provider} is temporarily unavailable (circuit open after repeated failures)`, "circuit_open", null, true, 0);
  }
  let last: ProviderHttpError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (o.signal?.aborted) throw new ProviderHttpError(`${o.provider} call cancelled`, "timeout", null, false, attempt - 1);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 15_000);
    const onAbort = () => ctl.abort();
    o.signal?.addEventListener("abort", onAbort);
    try {
      const res = await (injected(o.provider) ?? fetch)(url, { ...init, signal: ctl.signal });
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        if (o.breaker) await (await import("@/lib/runtime/breaker")).recordOutcome(o.breaker.companyId, scope, true).catch(() => null);
        return res; // 4xx (except 429) is the caller's to interpret — never retried
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      last = new ProviderHttpError(res.status === 429 ? `${o.provider} rate-limited the request` : `${o.provider} returned ${res.status}`, res.status === 429 ? "rate_limited" : "unavailable", res.status, true, attempt);
      if (attempt < maxAttempts && Date.now() - started < (o.maxTotalMs ?? 30_000)) await sleep(res.status === 429 && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : backoffMs(attempt, o.baseDelayMs));
    } catch (e) {
      const aborted = ctl.signal.aborted && !o.signal?.aborted;
      last = e instanceof ProviderHttpError ? e : new ProviderHttpError(aborted ? `${o.provider} did not respond within ${o.timeoutMs ?? 15_000} ms` : `${o.provider} is unreachable`, aborted ? "timeout" : "network", null, true, attempt);
      if (o.signal?.aborted) throw new ProviderHttpError(`${o.provider} call cancelled`, "timeout", null, false, attempt);
      if (attempt < maxAttempts && Date.now() - started < (o.maxTotalMs ?? 30_000)) await sleep(backoffMs(attempt, o.baseDelayMs));
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    }
  }
  if (o.breaker && last) await (await import("@/lib/runtime/breaker")).recordOutcome(o.breaker.companyId, scope, false, last.message).catch(() => null);
  if (!safe && last) last.message += " (not retried: the request is not idempotent)";
  throw last!;
}

/** Parse JSON defensively: a malformed provider response is a typed error, never a crash or a silent {}. */
export async function jsonOrThrow<T>(res: Response, provider: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderHttpError(`${provider} returned a malformed response (${text.slice(0, 60).replace(/\s+/g, " ")}…)`, "malformed", res.status, false, 1);
  }
}
