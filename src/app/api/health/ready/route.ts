import { prisma } from "@/lib/db";
import { workersStatus } from "@/lib/runtime/observe";
import { validateRuntimeConfig } from "@/lib/runtime/config";

export const dynamic = "force-dynamic";

/**
 * Readiness (load balancers / container healthchecks). 200 when the database
 * answers and configuration is valid. Worker liveness is REPORTED (it is a
 * separate process) — `requireWorker=1` makes a missing worker a 503, for
 * deployments that want the web tier to fail readiness without one.
 * No secrets or tenant data are returned.
 */
export async function GET(req: Request) {
  const out: Record<string, unknown> = {};
  let ready = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
    out.database = "ok";
  } catch {
    out.database = "down";
    ready = false;
  }
  const cfg = validateRuntimeConfig();
  out.config = cfg.ok ? "ok" : cfg.errors;
  if (!cfg.ok) ready = false;
  if (out.database === "ok") {
    const ws = await workersStatus();
    const online = ws.filter((w) => w.online);
    out.workers = { online: online.length, newestHeartbeatAgeMs: online[0]?.heartbeatAgeMs ?? null };
    // Payment webhooks that failed and are awaiting the provider's retry (count only).
    out.billingWebhooksFailing = await prisma.billingEvent.count({ where: { processed: false, attempts: { gt: 0 } } });
    if (new URL(req.url).searchParams.get("requireWorker") === "1" && !online.length) ready = false;
  }
  return new Response(JSON.stringify({ ready, ...out }), { status: ready ? 200 : 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
