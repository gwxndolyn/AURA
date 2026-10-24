import { ok, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { missionDetail } from "@/lib/missions/read";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; missionId: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, missionId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const m = await missionDetail(missionId, id);
  if (!m) throw new ApiError("Mission not found", 404);
  return ok(m);
});
