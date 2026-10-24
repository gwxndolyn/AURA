import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { missionScorecards } from "@/lib/missions/timeline";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Per-agent scorecards from mission evidence (sample size + definitions included). */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  return ok(await missionScorecards(id));
});
