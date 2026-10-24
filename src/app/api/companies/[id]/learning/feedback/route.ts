import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { recordFeedback } from "@/lib/learning/feedback";
import { emit } from "@/lib/learning/service";
import { rateLimit } from "@/lib/auth/rateLimit";
import { ApiError } from "@/lib/api";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({ text: z.string().min(3).max(2000), productId: z.string().max(40).optional(), itemKey: z.string().max(40).optional(), buildId: z.string().max(40).optional() });

/** Record an explicit correction (members). It becomes concrete criteria/instructions for future runs of that product. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requirePermission(id, "source.change");
  if (!rateLimit(`feedback:${id}:${user.userId}`, 30, 60 * 60_000).ok) throw new ApiError("Too much feedback this hour", 429);
  const b = await parseBody(req, Schema);
  const fb = await recordFeedback({ companyId: id, userId: user.userId, actor: user.email, ...b });
  if (b.buildId && fb.actions.some((a) => a.type === "rework")) await emit({ companyId: id, type: "rework.requested", key: `rework:${b.buildId}:${fb.id}`, productId: b.productId, buildId: b.buildId, payload: { text: fb.text } });
  await emit({ companyId: id, type: "feedback.recorded", key: `feedback:${fb.id}`, productId: b.productId, buildId: b.buildId, payload: { kind: fb.kind } });
  return ok(fb, { status: 201 });
});
