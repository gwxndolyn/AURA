import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { decide } from "@/lib/factory/maintenance";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string; proposalId: string }> };

const Schema = z.object({ decision: z.enum(["approve", "reject", "no_change", "reprioritise"]), priority: z.number().min(-100).max(500).optional() });

/** Approve / reject / mark "no change needed" / reprioritise (members; security-sensitive approvals need an admin). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId, proposalId } = await ctx.params;
  const { user, role } = await requirePermission(id, "source.change");
  const b = await parseBody(req, Schema);
  return ok(await decide(id, productId, proposalId, { email: user.email, role }, b.decision, b.priority));
});
