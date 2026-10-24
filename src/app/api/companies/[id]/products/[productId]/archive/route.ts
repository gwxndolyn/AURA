import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { archiveProduct, restoreProduct } from "@/lib/lifecycle/archive";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/** Archive (read-only, frees an active-product slot) or restore a product. product.archive (ADMIN+). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requirePermission(id, "product.archive");
  const { action } = await parseBody(req, z.object({ action: z.enum(["archive", "restore"]) }));
  return ok(action === "archive" ? await archiveProduct(id, productId, user.email) : await restoreProduct(id, productId, user.email));
});
