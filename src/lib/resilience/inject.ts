/**
 * Controlled failure injection for resilience tests (AURA V13).
 *
 * Hard restriction: active ONLY when NODE_ENV === "test" AND
 * AURA_FAULT_INJECTION === "1". In any other environment every function here
 * is a no-op — `assertInjectionAllowed` throws, and `injected()` returns null —
 * so a stray configuration can never interfere with production traffic.
 *
 * Scenarios (per provider scope): timeout · http_429 · http_500 · malformed ·
 * network · slow · expired_auth (401) · flaky(n) — fail the first n calls,
 * then succeed (recovery). Each scenario counts the calls it intercepted.
 */
export type FaultScenario = { kind: "timeout" | "http_429" | "http_500" | "malformed" | "network" | "slow" | "expired_auth" | "flaky"; failFirst?: number; delayMs?: number; retryAfterS?: number; okBody?: unknown };

const g = globalThis as unknown as { auraFaults?: Map<string, FaultScenario & { calls: number }> };
const faults = () => (g.auraFaults ??= new Map());

export function injectionAllowed(env: Record<string, string | undefined> = process.env) {
  return env.NODE_ENV === "test" && env.AURA_FAULT_INJECTION === "1";
}
export function assertInjectionAllowed() {
  if (!injectionAllowed()) throw new Error("Failure injection is only available in the test environment (NODE_ENV=test and AURA_FAULT_INJECTION=1)");
}

export function injectFault(provider: string, s: FaultScenario) {
  assertInjectionAllowed();
  faults().set(provider, { ...s, calls: 0 });
}
export function clearFaults() {
  faults().clear();
}
export function faultCalls(provider: string) {
  return faults().get(provider)?.calls ?? 0;
}

/** A fetch replacement for `provider`, or null (no fault, or injection not allowed). */
export function injected(provider: string): typeof fetch | null {
  if (!injectionAllowed()) return null;
  const f = faults().get(provider);
  if (!f) return null;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    f.calls++;
    const ok = () => new Response(JSON.stringify(f.okBody ?? { ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    if (f.kind === "flaky") return f.calls <= (f.failFirst ?? 1) ? new Response("upstream error", { status: 503 }) : ok();
    if (f.kind === "slow") { await new Promise((r) => setTimeout(r, f.delayMs ?? 50)); return ok(); }
    if (f.kind === "http_429") return new Response("slow down", { status: 429, headers: { "retry-after": String(f.retryAfterS ?? 0) } });
    if (f.kind === "http_500") return new Response("boom", { status: 500 });
    if (f.kind === "expired_auth") return new Response(JSON.stringify({ error: { message: "token expired" } }), { status: 401 });
    if (f.kind === "malformed") return new Response("<html>gateway error</html>", { status: 200 });
    if (f.kind === "network") throw new TypeError("fetch failed");
    // timeout: never resolve until aborted
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  }) as typeof fetch;
}
