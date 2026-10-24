import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requirePermission, requireWorkspaceAccess, WORKSPACE_ROLES } from "@/lib/auth/authz";
import { changeRole, removeMember } from "@/lib/auth/members";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; userId: string }> };

/** Change a member's role (member.manage; rules in src/lib/auth/members.ts). */
export const PATCH = handler(async (req, ctx: Ctx) => {
  const { id, userId } = await ctx.params;
  const { user, role } = await requirePermission(id, "member.manage");
  const body = await parseBody(req, z.object({ role: z.enum(WORKSPACE_ROLES) }));
  return ok(await changeRole(id, { ...user, role }, userId, body.role));
});

/** Remove a member (member.manage), or leave the workspace yourself (any role except owner). */
export const DELETE = handler(async (_req, ctx: Ctx) => {
  const { id, userId } = await ctx.params;
  const self = await requireWorkspaceAccess(id, "VIEWER");
  const access = self.user.userId === userId ? self : await requirePermission(id, "member.manage");
  return ok(await removeMember(id, { ...access.user, role: access.role }, userId));
});
