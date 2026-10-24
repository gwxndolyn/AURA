import { ok, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { runDetail } from "@/lib/missions/timeline";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; missionId: string; runId: string }> };

/** One task attempt: context provenance, validated output, claims, usage, tool calls. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, missionId, runId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const r = await runDetail(missionId, id, runId);
  if (!r) throw new ApiError("Run not found", 404);
  return ok(r);
});
