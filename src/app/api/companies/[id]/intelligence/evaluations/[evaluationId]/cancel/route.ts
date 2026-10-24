import { ok, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/events/emit";
import { cancelEvaluation } from "@/lib/intelligence/evaluation";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; evaluationId: string }> };

export const POST = handler(async (_req, ctx: Ctx) => {
  const { id, evaluationId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const ev = await prisma.evaluation.findFirst({ where: { id: evaluationId, companyId: id } });
  if (!ev) throw new ApiError("Evaluation not found", 404);
  if (ev.status !== "RUNNING") throw new ApiError(`Evaluation is ${ev.status}`, 409);
  const cancelled = cancelEvaluation(evaluationId);
  await audit(id, user.userId, "EVALUATION_CANCEL", evaluationId, cancelled ? "signalled" : "not running in this process");
  return ok({ cancelled });
});
