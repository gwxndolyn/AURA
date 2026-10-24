/** V13 resilience: timeouts, bounded retries with jitter, idempotency rules, 429, malformed responses, injection restrictions. */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { resilientFetch, retrySafe, backoffMs, jsonOrThrow, ProviderHttpError } from "./http";
import { injectFault, clearFaults, faultCalls, injectionAllowed, assertInjectionAllowed } from "./inject";

const noSleep = { sleep: async () => {} };
beforeEach(() => { process.env.AURA_FAULT_INJECTION = "1"; });
afterEach(() => { clearFaults(); delete process.env.AURA_FAULT_INJECTION; });

describe("resilient provider HTTP", () => {
  it("retries a GET on 5xx and recovers; never more than maxAttempts", async () => {
    injectFault("p1", { kind: "flaky", failFirst: 2 });
    const r = await resilientFetch("http://x/a", { method: "GET" }, { provider: "p1", maxAttempts: 3, ...noSleep });
    expect(r.status).toBe(200);
    expect(faultCalls("p1")).toBe(3);
    injectFault("p2", { kind: "http_500" });
    await expect(resilientFetch("http://x/a", {}, { provider: "p2", maxAttempts: 3, ...noSleep })).rejects.toMatchObject({ kind: "unavailable", attempts: 3 });
    expect(faultCalls("p2")).toBe(3);
  });

  it("never retries a non-idempotent POST (no duplicate side effects); retries it only with an Idempotency-Key", async () => {
    injectFault("pay", { kind: "http_500" });
    await expect(resilientFetch("http://x/charge", { method: "POST", body: "{}" }, { provider: "pay", maxAttempts: 4, ...noSleep })).rejects.toThrow(/not retried: the request is not idempotent/);
    expect(faultCalls("pay")).toBe(1);
    injectFault("pay2", { kind: "flaky", failFirst: 1 });
    expect((await resilientFetch("http://x/charge", { method: "POST", headers: { "Idempotency-Key": "k1" } }, { provider: "pay2", maxAttempts: 3, ...noSleep })).status).toBe(200);
    expect(faultCalls("pay2")).toBe(2);
    expect(retrySafe("POST", {})).toBe(false);
    expect(retrySafe("PUT", {})).toBe(true);
  });

  it("times out a hung provider, honours 429 as rate_limited, and types malformed/expired-auth responses", async () => {
    injectFault("slow", { kind: "timeout" });
    const t0 = Date.now();
    await expect(resilientFetch("http://x", {}, { provider: "slow", timeoutMs: 60, maxAttempts: 2, ...noSleep })).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - t0).toBeLessThan(2000);
    injectFault("rl", { kind: "http_429", retryAfterS: 0 });
    await expect(resilientFetch("http://x", {}, { provider: "rl", maxAttempts: 2, ...noSleep })).rejects.toMatchObject({ kind: "rate_limited", status: 429 });
    injectFault("bad", { kind: "malformed" });
    const r = await resilientFetch("http://x", {}, { provider: "bad", ...noSleep });
    await expect(jsonOrThrow(r, "bad")).rejects.toMatchObject({ kind: "malformed" });
    injectFault("auth", { kind: "expired_auth" });
    expect((await resilientFetch("http://x", {}, { provider: "auth", maxAttempts: 3, ...noSleep })).status).toBe(401); // 4xx is not retried
    expect(faultCalls("auth")).toBe(1);
  });

  it("propagates cancellation; backoff is bounded with full jitter", async () => {
    injectFault("hang", { kind: "timeout" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(resilientFetch("http://x", {}, { provider: "hang", timeoutMs: 5000, signal: ac.signal, ...noSleep })).rejects.toThrow(/cancelled/);
    for (let i = 1; i < 10; i++) expect(backoffMs(i, 200, 5000)).toBeLessThanOrEqual(5000);
    expect(backoffMs(3, 200, 5000, () => 0)).toBe(0);
  });

  it("failure injection cannot activate outside the test environment", () => {
    expect(injectionAllowed({ NODE_ENV: "production", AURA_FAULT_INJECTION: "1" })).toBe(false);
    expect(injectionAllowed({ NODE_ENV: "test" })).toBe(false);
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(() => assertInjectionAllowed()).toThrow(/only available in the test environment/);
    (process.env as Record<string, string>).NODE_ENV = prev!;
    expect(new ProviderHttpError("x", "network", null, true, 1).retryable).toBe(true);
  });
});
