import { ok, err, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; agentId: string }> };

/** Agent detail: profile + recent runs + tool calls + memory + touched files. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, agentId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  // Scope the agent to this workspace — never resolve an agent id from another company.
  const agent = await prisma.agent.findFirst({ where: { id: agentId, companyId: id } });
  if (!agent) return err("Agent not found", 404);

  const [runs, memories, tasks] = await Promise.all([
    prisma.agentRun.findMany({
      where: { agentId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { toolCalls: true },
    }),
    prisma.agentMemory.findMany({ where: { agentId }, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.task.findMany({ where: { assigneeId: agentId }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);

  return ok({ agent, runs, memories, tasks });
});
