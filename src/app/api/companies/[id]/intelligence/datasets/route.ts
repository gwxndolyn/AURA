import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { DATASETS, listDatasets } from "@/lib/intelligence/datasets";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Built-in, versioned, non-customer fixtures. `?full=1` includes case definitions. */
export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const full = new URL(req.url).searchParams.get("full") === "1";
  return ok(full ? DATASETS : listDatasets());
});
