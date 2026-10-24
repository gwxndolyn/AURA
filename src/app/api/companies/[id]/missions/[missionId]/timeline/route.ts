import { ok, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { missionTimeline } from "@/lib/missions/timeline";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; missionId: string }> };

/** Collaboration timeline built from persisted runs, handoffs, findings and approvals. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, missionId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const t = await missionTimeline(missionId, id);
  if (!t) throw new ApiError("Mission not found", 404);
  return ok(t);
});
