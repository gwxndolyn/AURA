import { ok, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { buildReport } from "@/lib/missions/report";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; missionId: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, missionId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const r = await buildReport(missionId, id);
  if (!r) throw new ApiError("Mission not found", 404);
  return ok(r);
});
