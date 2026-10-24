import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { transferOwnership } from "@/lib/auth/members";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Transfer ownership to an existing member (owner only). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requirePermission(id, "ownership.transfer");
  const { userId } = await parseBody(req, z.object({ userId: z.string().min(1).max(40) }));
  return ok(await transferOwnership(id, user, userId));
});
