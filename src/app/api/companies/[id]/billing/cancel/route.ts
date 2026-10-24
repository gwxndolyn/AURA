import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { cancelPlan } from "@/lib/billing/service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Cancel at period end ({resume:true} withdraws a scheduled cancellation). billing.manage. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requirePermission(id, "billing.manage");
  const { resume } = await parseBody(req, z.object({ resume: z.boolean().default(false) }));
  return ok(await cancelPlan(id, user.email, resume));
});
