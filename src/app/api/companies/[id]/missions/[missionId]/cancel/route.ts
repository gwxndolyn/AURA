import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { cancelMission } from "@/lib/missions/engine";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; missionId: string }> };

export const POST = handler(async (_req, ctx: Ctx) => {
  const { id, missionId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  await cancelMission(missionId, id, user.email);
  return ok({ cancelled: true });
});
