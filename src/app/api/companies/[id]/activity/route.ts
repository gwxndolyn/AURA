import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { listMessages } from "@/lib/agents/messaging";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Audit log + timeline + agent messages for the Activity page. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const [audit, timeline, messages] = await Promise.all([
    prisma.auditLog.findMany({ where: { companyId: id }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.timelineEvent.findMany({ where: { companyId: id }, orderBy: { createdAt: "asc" } }),
    listMessages(id, 40),
  ]);
  return ok({ audit, timeline, messages });
});
