import { ok, err, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { usageSummary } from "@/lib/ai/budget";
import { computeSecurityScore } from "@/lib/company/security";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Aggregated snapshot powering the main dashboard in one request. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const company = await prisma.company.findUnique({ where: { id } });
  if (!company) return err("Company not found", 404);

  const [
    agents,
    tasksByStatus,
    openFindings,
    activeIncidents,
    deployments,
    events,
    usage,
    security,
    nodes,
  ] = await Promise.all([
    prisma.agent.findMany({ where: { companyId: id }, orderBy: { tasksDone: "desc" } }),
    prisma.task.groupBy({ by: ["status"], where: { companyId: id }, _count: true }),
    prisma.securityFinding.count({ where: { companyId: id, status: { in: ["OPEN", "PATCHING"] } } }),
    prisma.incident.count({ where: { companyId: id, status: "ACTIVE" } }),
    prisma.deployment.findMany({ where: { companyId: id }, orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.simulationEvent.findMany({
      where: { companyId: id },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    usageSummary(id),
    computeSecurityScore(id),
    prisma.infrastructureNode.findMany({ where: { companyId: id } }),
  ]);

  const taskCounts: Record<string, number> = {};
  for (const t of tasksByStatus) taskCounts[t.status] = t._count;

  return ok({
    company,
    agents,
    taskCounts,
    openFindings,
    activeIncidents,
    deployments,
    events,
    usage,
    security,
    nodes,
  });
});
