import { ok, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { aiSummary } from "@/lib/ops/briefing";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * Optional AI summary of the open findings (one model call, user-initiated,
 * only when enabled for the workspace). Falls back to the deterministic text.
 */
export const POST = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const mon = await prisma.opsMonitor.findUnique({ where: { companyId: id } });
  if (!mon?.aiSummaries) throw new ApiError("AI summaries are disabled for this workspace (enable them in monitor settings)", 409);
  return ok(await aiSummary(id));
});
