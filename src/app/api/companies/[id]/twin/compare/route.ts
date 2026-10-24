import { ok, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { compareRuns } from "@/lib/twin/runs";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 4);
  if (ids.some((x) => x.length > 40)) throw new ApiError("Bad run id", 422);
  return ok(await compareRuns(id, ids));
});
