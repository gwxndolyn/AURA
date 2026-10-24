import { ok, handler } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { revokeInvitation } from "@/lib/auth/members";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; invitationId: string }> };

export const DELETE = handler(async (_req, ctx: Ctx) => {
  const { id, invitationId } = await ctx.params;
  const { user } = await requirePermission(id, "member.manage");
  return ok(await revokeInvitation(id, user.email, invitationId));
});
