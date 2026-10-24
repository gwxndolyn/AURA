/**
 * Lightweight fixed-window rate limiter (in-process). For production multi-
 * instance deployments this should be backed by Redis; the interface is kept
 * small so it can be swapped. Stored on globalThis to survive HMR.
 */
const globalForRL = globalThis as unknown as { auraRL?: Map<string, { count: number; resetAt: number }> };
function store() {
  if (!globalForRL.auraRL) globalForRL.auraRL = new Map();
  return globalForRL.auraRL;
}

export function rateLimit(key: string, max: number, windowMs: number): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const rec = store().get(key);
  if (!rec || now >= rec.resetAt) {
    store().set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterMs: 0 };
  }
  if (rec.count >= max) return { ok: false, retryAfterMs: rec.resetAt - now };
  rec.count++;
  return { ok: true, retryAfterMs: 0 };
}
