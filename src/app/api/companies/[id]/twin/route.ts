import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess, ROLE_RANK } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { liveDepartments } from "@/lib/twin/departments";
import { operationalMetrics } from "@/lib/twin/metrics";
import { getConfig } from "@/lib/twin/config";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Company twin overview: real department state + operational metrics + CEO config. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { role } = await requireWorkspaceAccess(id, "VIEWER");
  const [company, live, metrics, config] = await Promise.all([
    prisma.company.findUnique({ where: { id }, select: { name: true, mission: true, industry: true, isDemo: true } }),
    liveDepartments(id),
    operationalMetrics(id),
    getConfig(id),
  ]);
  return ok({ company, live, metrics, config, canDecide: ROLE_RANK[role] >= ROLE_RANK.ADMIN, canRun: ROLE_RANK[role] >= ROLE_RANK.MEMBER });
});
