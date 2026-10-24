import { z } from "zod";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";
import { loadProduct, assertNotArchived } from "@/lib/factory/store";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/** Start a maintenance cycle (durable job) or cancel a running one. Members may start; the product's mode decides what it may do. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requirePermission(id, "execution.start");
  const p = await loadProduct(id, productId);
  assertNotArchived(p);
  const b = await parseBody(req, z.object({ action: z.enum(["start", "cancel"]).default("start"), cycleId: z.string().max(40).optional() }));
  if (b.action === "cancel") {
    const r = await prisma.maintenanceCycle.updateMany({ where: { id: b.cycleId, companyId: id, productId, status: "RUNNING" }, data: { status: "CANCELLED", finishedAt: new Date(), summary: `cancelled by ${user.email}` } });
    if (!r.count) throw new ApiError("No running cycle with that id", 404);
    return ok({ cancelled: true });
  }
  const job = await enqueue({ companyId: id, type: "maintenance.cycle", payload: { productId, actor: user.email }, dedupeKey: `maint:${productId}:${Math.floor(Date.now() / 60_000)}`, maxAttempts: 2, createdBy: user.email });
  return ok({ jobId: job.id }, { status: 202 });
});
