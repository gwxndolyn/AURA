import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { rollbackItem } from "@/lib/factory/release";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string; key: string }> };

/** Revert AURA's commits for one task on its branch (new commits; other people's commits are kept). MEMBER+. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId, key } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const { reason } = await parseBody(req, z.object({ reason: z.string().max(300).optional() }));
  return ok(await rollbackItem(id, productId, decodeURIComponent(key), user.email, reason ?? ""));
});
