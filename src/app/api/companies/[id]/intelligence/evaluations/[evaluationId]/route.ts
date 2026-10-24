import { ok, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; evaluationId: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, evaluationId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const ev = await prisma.evaluation.findFirst({ where: { id: evaluationId, companyId: id }, include: { results: { orderBy: { createdAt: "asc" } } } });
  if (!ev) throw new ApiError("Evaluation not found", 404);
  return ok(ev);
});
