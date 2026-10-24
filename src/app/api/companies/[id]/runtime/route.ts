import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { audit } from "@/lib/events/emit";
import { workersStatus, runtimeMetrics, evaluateAlerts } from "@/lib/runtime/observe";
import { DEFAULT_RUNTIME_LIMITS, enqueue } from "@/lib/jobs/queue";
import { resetBreaker } from "@/lib/runtime/breaker";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Control-plane overview: workers (with heartbeats), settings, metrics, alerts — all persisted state. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { role } = await requireWorkspaceAccess(id, "VIEWER");
  const [settings, global, workers, metrics, alerts] = await Promise.all([
    prisma.runtimeSettings.findUnique({ where: { companyId: id } }),
    prisma.runtimeSettings.findUnique({ where: { companyId: "*" } }),
    workersStatus(),
    runtimeMetrics(id),
    evaluateAlerts(id),
  ]);
  return ok({
    role,
    settings: { autonomyEnabled: settings?.autonomyEnabled ?? true, globalAutonomyEnabled: global?.autonomyEnabled ?? true, limits: { ...DEFAULT_RUNTIME_LIMITS, ...parseJSON(global?.limits, {}), ...parseJSON(settings?.limits, {}) }, version: settings?.version ?? 0, updatedBy: settings?.updatedBy ?? "" },
    workers: workers.map((w) => ({ id: w.id, host: w.host, mode: w.mode, status: w.status, online: w.online, heartbeatAt: w.heartbeatAt, heartbeatAgeMs: w.heartbeatAgeMs, running: w.running.length, processed: w.processed, failed: w.failed, startedAt: w.startedAt, version: w.version })),
    metrics,
    alerts,
  });
});

const Patch = z.union([
  z.object({ action: z.literal("autonomy"), enabled: z.boolean(), reason: z.string().max(300).optional() }),
  z.object({ action: z.literal("limits"), limits: z.object({ maxConcurrentJobs: z.number().int().min(0).max(32), maxConcurrentPerKey: z.number().int().min(1).max(8) }).partial() }),
  z.object({ action: z.literal("reset_breaker"), scope: z.string().max(120) }),
  z.object({ action: z.literal("ping") }),
]);

/**
 * ADMIN: kill switch (autonomy on/off — takes effect at the next claim; running jobs are asked to stop via
 * their cancellation check when autonomy is disabled with `stopRunning`), runtime limits, breaker reset,
 * and a ping job that proves a worker is consuming the queue.
 */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const b = await parseBody(req, Patch);
  if (b.action === "ping") {
    const job = await enqueue({ companyId: id, type: "runtime.ping", payload: {}, createdBy: user.email, priority: 0, maxAttempts: 1 });
    return ok({ jobId: job.id }, { status: 202 });
  }
  if (b.action === "reset_breaker") {
    await resetBreaker(id, b.scope);
    await audit(id, user.email, "RUNTIME_BREAKER_RESET", id, b.scope);
    return ok({ reset: b.scope });
  }
  const cur = await prisma.runtimeSettings.upsert({ where: { companyId: id }, create: { companyId: id }, update: {} });
  const data = b.action === "autonomy" ? { autonomyEnabled: b.enabled } : { limits: JSON.stringify({ ...parseJSON(cur.limits, {}), ...b.limits }) };
  const s = await prisma.runtimeSettings.update({ where: { companyId: id }, data: { ...data, version: { increment: 1 }, updatedBy: user.email } });
  if (b.action === "autonomy" && !b.enabled) {
    // Kill switch also stops in-flight autonomous work: queued jobs are held (not claimed), running goal steps are cancelled.
    const goals = await prisma.goal.findMany({ where: { companyId: id, status: { in: ["QUEUED", "RUNNING", "WAITING"] } } });
    for (const g of goals) {
      await prisma.goal.update({ where: { id: g.id }, data: { status: "PAUSED", statusReason: `autonomy disabled by ${user.email}${b.reason ? `: ${b.reason}` : ""}` } });
      if (g.currentJobId) await prisma.job.updateMany({ where: { id: g.currentJobId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", finishedAt: new Date() } });
    }
  }
  await audit(id, user.email, "RUNTIME_SETTINGS", id, b.action === "autonomy" ? `autonomy ${b.enabled ? "enabled" : "DISABLED"}${"reason" in b && b.reason ? `: ${b.reason}` : ""}` : `limits ${s.limits}`);
  return ok({ autonomyEnabled: s.autonomyEnabled, limits: parseJSON(s.limits, {}), version: s.version });
});
