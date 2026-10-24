import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { listMembers } from "@/lib/auth/members";
import { effectivePlan, seatsInUse } from "@/lib/billing/entitlements";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Members, pending invitations and seat usage. Any member may see who else is in the workspace. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { role, user } = await requireWorkspaceAccess(id, "VIEWER");
  const [list, { plan }, seats] = await Promise.all([listMembers(id), effectivePlan(id), seatsInUse(id)]);
  return ok({ ...list, invitations: ["ADMIN", "OWNER"].includes(role) ? list.invitations : [], seats: { used: seats, limit: plan.limits.seats }, me: { userId: user.userId, role } });
});
