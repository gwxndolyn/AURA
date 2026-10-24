import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { intelligenceOverview } from "@/lib/learning/workspace";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Engineering-intelligence workspace (persisted records only). ?product=<id>&q=<search>. */
export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const u = new URL(req.url);
  return ok(await intelligenceOverview(id, { productId: u.searchParams.get("product") ?? undefined, q: u.searchParams.get("q")?.slice(0, 100) || undefined }));
});
