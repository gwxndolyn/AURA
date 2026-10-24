import { ok, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";
import { loadProduct } from "@/lib/factory/store";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/** Retry AI planning after a failure (re-queues the planning job; nothing is fabricated meanwhile). */
export const POST = handler(async (_req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const p = await loadProduct(id, productId);
  if (p.planningStatus !== "FAILED") throw new ApiError(`Planning is ${p.planningStatus.toLowerCase()}`, 409);
  await prisma.product.update({ where: { id: p.id }, data: { planningStatus: "QUEUED", planningError: "" } });
  const job = await enqueue({ companyId: id, type: "product.plan", payload: { productId }, dedupeKey: `plan:${productId}:${Date.now()}`, createdBy: user.email });
  return ok({ jobId: job.id, planningStatus: "QUEUED" });
});
