import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { tickProduct } from "@/lib/factory/scheduler";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/** One bounded scheduler tick (dispatch ready work, advance missions, settle from evidence). Idempotent. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const b = await parseBody(req, z.object({ steps: z.number().int().min(1).max(20).optional() }));
  return ok(await tickProduct(id, productId, { actor: user.email, steps: b.steps }));
});
