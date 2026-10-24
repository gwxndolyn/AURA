/**
 * Runtime observability from persisted rows only (no in-memory counters):
 * workers + heartbeats, queue depth / wait, job outcomes, retries, duration,
 * provider failures, recoveries, breakers, goals, schedules, improvement
 * experiments, and actionable alerts. Alerts are also written as in-app
 * Notifications (deduplicated per open condition).
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { WORKER_STALE_MS } from "@/lib/jobs/worker";

export async function workersStatus() {
  const rows = await prisma.worker.findMany({ where: { OR: [{ status: { not: "STOPPED" } }, { stoppedAt: { gte: new Date(Date.now() - 24 * 3600_000) } }] }, orderBy: { heartbeatAt: "desc" }, take: 30 });
  const now = Date.now();
  return rows.map((w) => ({ ...w, running: parseJSON<string[]>(w.running, []), online: w.status !== "STOPPED" && now - w.heartbeatAt.getTime() < WORKER_STALE_MS, heartbeatAgeMs: now - w.heartbeatAt.getTime() }));
}

export async function runtimeMetrics(companyId: string, windowMs = 24 * 3600_000) {
  const since = new Date(Date.now() - windowMs);
  const [byStatus, queued, finished, events, breakers, goals, schedules, experiments] = await Promise.all([
    prisma.job.groupBy({ by: ["status"], where: { companyId }, _count: true }),
    prisma.job.findMany({ where: { companyId, status: "QUEUED", runAt: { lte: new Date() } }, select: { runAt: true }, orderBy: { runAt: "asc" }, take: 500 }),
    prisma.job.findMany({ where: { companyId, finishedAt: { gte: since } }, select: { type: true, status: true, attempts: true, startedAt: true, finishedAt: true, errorKind: true } }),
    prisma.jobEvent.groupBy({ by: ["type"], where: { companyId, createdAt: { gte: since } }, _count: true }),
    prisma.circuitBreaker.findMany({ where: { companyId, state: { not: "CLOSED" } } }),
    prisma.goal.groupBy({ by: ["status"], where: { companyId }, _count: true }),
    prisma.schedule.findMany({ where: { companyId }, orderBy: { nextRunAt: "asc" }, take: 50 }),
    prisma.labExperiment.groupBy({ by: ["status"], where: { companyId, createdAt: { gte: since } }, _count: true }),
  ]);
  const now = Date.now();
  const durations = finished.filter((f) => f.startedAt && f.finishedAt).map((f) => f.finishedAt!.getTime() - f.startedAt!.getTime()).sort((a, b) => a - b);
  const pct = (p: number) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(p * durations.length))] : null);
  const ok = finished.filter((f) => f.status === "SUCCEEDED").length;
  const failureKinds = new Map<string, number>();
  for (const f of finished.filter((x) => x.status !== "SUCCEEDED")) failureKinds.set(f.errorKind ?? "unknown", (failureKinds.get(f.errorKind ?? "unknown") ?? 0) + 1);
  const ev = Object.fromEntries(events.map((e) => [e.type, e._count]));
  const tests = await prisma.commandRun.findMany({ where: { companyId, actor: "engine", purpose: "test", createdAt: { gte: since } }, select: { exitCode: true } });
  const cost = await prisma.usageEvent.aggregate({ where: { companyId, metric: "ai_cost_usd", createdAt: { gte: since } }, _sum: { quantity: true } });
  return {
    windowHours: windowMs / 3600_000,
    jobs: { byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])), finished: finished.length, successRate: finished.length ? ok / finished.length : null, retries: ev.retry_scheduled ?? 0, p50Ms: pct(0.5), p95Ms: pct(0.95), failureKinds: Object.fromEntries(failureKinds) },
    queue: { dueNow: queued.length, oldestWaitMs: queued[0] ? now - queued[0].runAt.getTime() : null },
    recovery: { leaseReclaimed: ev.lease_reclaimed ?? 0, released: ev.released ?? 0, timeouts: ev.timeout ?? 0, resumed: ev.resumed ?? 0, checkpoints: ev.checkpoint ?? 0 },
    provider: { failures: finished.filter((f) => f.errorKind?.startsWith("provider_")).length },
    tests: { runs: tests.length, passRate: tests.length ? tests.filter((t) => t.exitCode === 0).length / tests.length : null },
    cost: { estimatedUsd: cost._sum.quantity ?? 0, source: "estimate: provider-reported tokens × list price (src/lib/ai/pricing.ts)" },
    breakers: breakers.map((b) => ({ scope: b.scope, state: b.state, failures: b.failures, reason: b.reason, reopenAt: b.reopenAt })),
    goals: Object.fromEntries(goals.map((g) => [g.status, g._count])),
    experiments: Object.fromEntries(experiments.map((e) => [e.status, e._count])),
    schedules: schedules.map((s) => ({ id: s.id, name: s.name, jobType: s.jobType, spec: s.spec, enabled: s.enabled, nextRunAt: s.nextRunAt, lastRunAt: s.lastRunAt, runs: s.runs })),
  };
}

export interface Alert { key: string; severity: "medium" | "high"; title: string; detail: string }

/** Evaluate alert conditions from persisted state; upsert/clear Notifications. */
export async function evaluateAlerts(companyId: string) {
  const alerts: Alert[] = [];
  const now = Date.now();
  const workers = await workersStatus();
  const online = workers.filter((w) => w.online);
  const pending = await prisma.job.count({ where: { companyId, status: { in: ["QUEUED", "RUNNING"] } } });
  if (pending && !online.length) alerts.push({ key: "no-worker", severity: "high", title: "No worker is online", detail: `${pending} job(s) are waiting and no worker has heart-beaten in the last ${Math.round(WORKER_STALE_MS / 1000)} s. Start one with \`npm run worker\` (or AURA_WORKER=inline).` });
  const stale = await prisma.job.findMany({ where: { companyId, status: "RUNNING", leaseUntil: { lt: new Date(now) } }, select: { id: true, type: true }, take: 10 });
  if (stale.length) alerts.push({ key: "stalled-jobs", severity: "high", title: `${stale.length} job(s) stalled`, detail: `Leases expired (worker died?): ${stale.map((s) => `${s.type} ${s.id.slice(-6)}`).join(", ")}. A live worker will reclaim them.` });
  const oldest = await prisma.job.findFirst({ where: { companyId, status: "QUEUED", runAt: { lt: new Date(now - 15 * 60_000) } }, orderBy: { runAt: "asc" } });
  if (oldest && online.length) alerts.push({ key: "queue-wait", severity: "medium", title: "Jobs waiting longer than 15 minutes", detail: `Oldest: ${oldest.type} since ${oldest.runAt.toISOString()} (limits, dependencies, kill switch or an open breaker may hold it).` });
  for (const b of await prisma.circuitBreaker.findMany({ where: { companyId, state: "OPEN" } })) alerts.push({ key: `breaker:${b.scope}`, severity: "high", title: `Circuit open: ${b.scope}`, detail: `${b.failures} consecutive failures: ${b.reason}. Re-probes at ${b.reopenAt?.toISOString() ?? "manual reset"}.` });
  for (const g of await prisma.goal.findMany({ where: { companyId, status: { in: ["BUDGET_EXHAUSTED", "BLOCKED"] } }, take: 10 })) alerts.push({ key: `goal:${g.id}:${g.status}`, severity: "high", title: `Goal ${g.status.toLowerCase().replace("_", " ")}: ${g.title}`, detail: g.statusReason });
  const regress = await prisma.labExperiment.count({ where: { companyId, status: "REJECTED", finishedAt: { gte: new Date(now - 24 * 3600_000) } } });
  if (regress >= 3) alerts.push({ key: "repeated-regressions", severity: "medium", title: "Repeated rejected improvement experiments", detail: `${regress} experiments were rejected in 24 h (regressions or no benefit). Review the candidates before scheduling more cycles.` });
  alerts.push(...(await commercialAlerts(companyId, now)));
  const keys = alerts.map((a) => `runtime:${a.key}`);
  for (const a of alerts) await prisma.notification.upsert({ where: { companyId_dedupeKey: { companyId, dedupeKey: `runtime:${a.key}` } }, create: { companyId, dedupeKey: `runtime:${a.key}`, kind: "intervention", severity: a.severity, title: a.title.slice(0, 200), body: a.detail.slice(0, 500), href: "/autopilot" }, update: { body: a.detail.slice(0, 500) } });
  await prisma.notification.deleteMany({ where: { companyId, dedupeKey: { startsWith: "runtime:", notIn: keys } } });
  return alerts;
}

/**
 * Commercial alerts: quota warnings at 80%, abnormal spend (today's estimated
 * AI cost > 3× the trailing 7-day daily average and > $1), repeated denied
 * access (≥ 10 in an hour) and payment failures. Raised in-app for the
 * workspace; platform-wide signals (webhook failures, dead jobs) are in
 * /api/admin/overview and the structured logs.
 */
export async function commercialAlerts(companyId: string, now = Date.now()): Promise<Alert[]> {
  const out: Alert[] = [];
  const { effectivePlan, usageThisMonth } = await import("@/lib/billing/entitlements");
  const { plan } = await effectivePlan(companyId);
  const u = await usageThisMonth(companyId);
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { monthlyBudgetUsd: true } });
  const aiLimit = Math.min(plan.limits.aiBudgetUsdPerMonth, company?.monthlyBudgetUsd ?? Infinity);
  const near = (used: number, limit: number) => limit > 0 && used / limit >= 0.8;
  if (near(u.aiCostUsd, aiLimit)) out.push({ key: "quota:ai", severity: u.aiCostUsd >= aiLimit ? "high" : "medium", title: u.aiCostUsd >= aiLimit ? "AI budget reached — runs are stopped" : "AI budget 80% used", detail: `$${u.aiCostUsd.toFixed(2)} of $${aiLimit.toFixed(2)} this month (estimated). Raise the spending cap or upgrade in Settings.` });
  if (near(u.builds, plan.limits.buildsPerMonth)) out.push({ key: "quota:builds", severity: u.builds >= plan.limits.buildsPerMonth ? "high" : "medium", title: `Engineering runs ${Math.round((u.builds / plan.limits.buildsPerMonth) * 100)}% used`, detail: `${u.builds} of ${plan.limits.buildsPerMonth} on ${plan.name} this month.` });
  if (near(u.sandboxMinutes, plan.limits.sandboxMinutesPerMonth)) out.push({ key: "quota:sandbox", severity: "medium", title: "Sandbox minutes 80% used", detail: `${Math.round(u.sandboxMinutes)} of ${plan.limits.sandboxMinutesPerMonth} min this month.` });
  const dayStart = new Date(now - 24 * 3600_000);
  const today = (await prisma.usageEvent.aggregate({ where: { companyId, metric: "ai_cost_usd", createdAt: { gte: dayStart } }, _sum: { quantity: true } }))._sum.quantity ?? 0;
  const week = (await prisma.usageEvent.aggregate({ where: { companyId, metric: "ai_cost_usd", createdAt: { gte: new Date(now - 8 * 86400_000), lt: dayStart } }, _sum: { quantity: true } }))._sum.quantity ?? 0;
  if (today > 1 && today > 3 * (week / 7)) out.push({ key: "cost-spike", severity: "high", title: "Unusual AI spend in the last 24 hours", detail: `$${today.toFixed(2)} in 24 h vs a 7-day average of $${(week / 7).toFixed(2)}/day (estimated). Check running goals and products.` });
  const denied = await prisma.auditLog.count({ where: { companyId, outcome: "denied", createdAt: { gte: new Date(now - 3600_000) } } });
  if (denied >= 10) out.push({ key: "denied-access", severity: "high", title: "Repeated denied access attempts", detail: `${denied} actions were refused by role checks in the last hour. Review Settings → Security.` });
  return out;
}
