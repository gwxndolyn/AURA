import { ok, handler } from "@/lib/api";
import { requirePlatformAdmin } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Platform-operator overview (User.isPlatformAdmin; 404 for everyone else).
 * Aggregates only — no customer content, code, secrets or emails. Every access
 * is recorded in PlatformAudit.
 */
export const GET = handler(async () => {
  const admin = await requirePlatformAdmin();
  const since = new Date(Date.now() - 24 * 3600_000);
  const [users, workspaces, paid, pastDue, failedWebhooks, deadJobs, runs24h, deniedAccess24h] = await Promise.all([
    prisma.user.count(),
    prisma.company.count({ where: { isDemo: false } }),
    prisma.subscription.count({ where: { plan: { not: "free" }, status: { in: ["active", "trialing"] } } }),
    prisma.subscription.count({ where: { status: "past_due" } }),
    prisma.billingEvent.count({ where: { processed: false, attempts: { gt: 0 } } }),
    prisma.job.count({ where: { status: "DEAD", finishedAt: { gte: since } } }),
    prisma.build.count({ where: { createdAt: { gte: since } } }),
    prisma.auditLog.count({ where: { outcome: "denied", createdAt: { gte: since } } }),
  ]);
  await prisma.platformAudit.create({ data: { actor: admin.email, action: "ADMIN_OVERVIEW_VIEWED", result: "aggregates only" } });
  return ok({ users, workspaces, subscriptions: { paid, pastDue }, last24h: { failedWebhooks, deadJobs, runs: runs24h, deniedAccess: deniedAccess24h } });
});
