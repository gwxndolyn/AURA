/**
 * Fixed-window rate limiter (in-process). For multi-instance deployments put
 * a shared limiter (Redis or the edge/WAF) in front; the interface is kept
 * small so it can be swapped. Stored on globalThis to survive HMR. Bounded:
 * expired windows are pruned so memory cannot grow without limit.
 */
const globalForRL = globalThis as unknown as { auraRL?: Map<string, { count: number; resetAt: number }> };
function store() {
  if (!globalForRL.auraRL) globalForRL.auraRL = new Map();
  return globalForRL.auraRL;
}

export function rateLimit(key: string, max: number, windowMs: number): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const s = store();
  if (s.size > 50_000) for (const [k, v] of s) if (now >= v.resetAt) s.delete(k);
  const rec = s.get(key);
  if (!rec || now >= rec.resetAt) {
    s.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterMs: 0 };
  }
  if (rec.count >= max) return { ok: false, retryAfterMs: rec.resetAt - now };
  rec.count++;
  return { ok: true, retryAfterMs: 0 };
}

/** Test helper: forget all windows. */
export function resetRateLimits() {
  store().clear();
}

/**
 * Client IP for rate limiting. Only the first X-Forwarded-For hop is used and
 * only when AURA_TRUST_PROXY=1 (behind a proxy you control); otherwise a client
 * could rotate the header to escape limits.
 */
export function clientIp(req: Request): string {
  if (process.env.AURA_TRUST_PROXY === "1") {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim().slice(0, 64);
    const real = req.headers.get("x-real-ip");
    if (real) return real.slice(0, 64);
  }
  return "direct";
}
