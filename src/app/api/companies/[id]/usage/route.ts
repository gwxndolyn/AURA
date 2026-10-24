import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { usageSummary } from "@/lib/ai/budget";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const [usage, agents, recentRuns] = await Promise.all([
    usageSummary(id),
    prisma.agent.findMany({
      where: { companyId: id },
      select: { id: true, name: true, key: true, color: true, avatar: true, cost: true, tokensIn: true, tokensOut: true },
    }),
    prisma.agentRun.findMany({
      where: { companyId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { agent: { select: { name: true, color: true, avatar: true } } },
    }),
  ]);
  return ok({ usage, agents, recentRuns });
});
