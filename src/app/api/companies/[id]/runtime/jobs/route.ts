import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "DEAD", "CANCELLED"];

/** Jobs of this workspace, optionally ?status=FAILED&type=build.run. */
export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const u = new URL(req.url);
  const status = u.searchParams.get("status");
  const type = u.searchParams.get("type");
  const rows = await prisma.job.findMany({ where: { companyId: id, ...(status && STATUSES.includes(status) ? { status } : {}), ...(type ? { type: type.slice(0, 60) } : {}) }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, type: true, status: true, priority: true, attempts: true, maxAttempts: true, runAt: true, startedAt: true, finishedAt: true, leaseUntil: true, workerId: true, lastError: true, errorKind: true, progress: true, goalId: true, scheduleId: true, dependsOn: true, deadline: true, createdBy: true } });
  return ok(rows);
});
