import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { audit } from "@/lib/events/emit";
import { controlProduct } from "@/lib/factory/scheduler";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/** Pause / resume / cancel; propagates to in-flight missions and reports anything that could not stop immediately. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const { action } = await parseBody(req, z.object({ action: z.enum(["pause", "resume", "cancel"]) }));
  const r = await controlProduct(id, productId, action, user.email);
  await audit(id, user.email, `PRODUCT_${action.toUpperCase()}`, productId, r.notes.join("; ") || "ok");
  return ok(r);
});
