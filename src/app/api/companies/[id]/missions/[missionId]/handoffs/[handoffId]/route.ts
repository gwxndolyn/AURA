import { ok, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { handoffDetail } from "@/lib/missions/timeline";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; missionId: string; handoffId: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, missionId, handoffId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const h = await handoffDetail(missionId, id, handoffId); // scoped by mission + workspace (IDOR-safe)
  if (!h) throw new ApiError("Handoff not found", 404);
  return ok(h);
});
