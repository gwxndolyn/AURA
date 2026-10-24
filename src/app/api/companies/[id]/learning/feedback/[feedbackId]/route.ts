import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { updateFeedback, deleteFeedback } from "@/lib/learning/feedback";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; feedbackId: string }> };

/** Enable/disable or re-scope a saved preference. */
export const PATCH = handler(async (req, ctx: Ctx) => {
  const { id, feedbackId } = await ctx.params;
  const { user } = await requirePermission(id, "source.change");
  const b = await parseBody(req, z.object({ status: z.enum(["ACTIVE", "DISABLED"]).optional(), scope: z.enum(["product", "workspace"]).optional() }));
  return ok(await updateFeedback(id, feedbackId, user.email, b));
});

export const DELETE = handler(async (_req, ctx: Ctx) => {
  const { id, feedbackId } = await ctx.params;
  const { user } = await requirePermission(id, "source.change");
  return ok(await deleteFeedback(id, feedbackId, user.email));
});
