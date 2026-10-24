/**
 * Post-deployment verification against the DEPLOYED URL (not a local
 * preview): the health path must answer 2xx within a bounded wait (the
 * container needs a moment to start), then each configured journey check
 * (path + expected status + optional expected text) must pass. Results are
 * stored on the deployment as evidence.
 */
import type { TargetConfig } from "./providers";

export interface HealthCheck { path: string; ok: boolean; status: number | null; ms: number; detail: string }

async function hit(url: string, timeoutMs = 5000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    const body = (await r.text()).slice(0, 20_000);
    return { status: r.status, body, ms: Date.now() - t0, error: "" };
  } catch (e) {
    return { status: null, body: "", ms: Date.now() - t0, error: (e as Error).message };
  }
}

export async function verifyDeployment(baseUrl: string, cfg: TargetConfig, opts: { startupMs?: number } = {}) {
  const checks: HealthCheck[] = [];
  const health = cfg.healthPath ?? "/api/health";
  const deadline = Date.now() + (opts.startupMs ?? Number(process.env.AURA_DEPLOY_STARTUP_MS || 30_000));
  let last = await hit(baseUrl + health);
  while (!(last.status && last.status >= 200 && last.status < 300) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 750));
    last = await hit(baseUrl + health);
  }
  checks.push({ path: health, ok: !!last.status && last.status >= 200 && last.status < 300, status: last.status, ms: last.ms, detail: last.error || `HTTP ${last.status}` });
  if (!checks[0].ok) return { ok: false, checks };
  for (const j of cfg.journeys ?? [{ path: "/", expectStatus: 200 }]) {
    const r = await hit(baseUrl + j.path);
    const statusOk = r.status === (j.expectStatus ?? 200);
    const textOk = !j.expectText || r.body.includes(j.expectText);
    checks.push({ path: j.path, ok: statusOk && textOk, status: r.status, ms: r.ms, detail: r.error || `HTTP ${r.status}${j.expectText ? textOk ? `; found "${j.expectText}"` : `; "${j.expectText}" not found` : ""}` });
  }
  return { ok: checks.every((c) => c.ok), checks };
}
