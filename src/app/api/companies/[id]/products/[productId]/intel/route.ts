import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { productIntel } from "@/lib/factory/intel";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/** Code index of the default branch; ?item=<key> adds the files/tests related to that task and its last run's impact. */
export const GET = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  return ok(await productIntel(id, productId, new URL(req.url).searchParams.get("item")));
});
