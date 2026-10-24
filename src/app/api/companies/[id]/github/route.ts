import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { githubStatus, installState } from "@/lib/integrations/github/service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Integration status + an install URL carrying a signed state for this workspace (ADMIN starts installs). */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user, role } = await requireWorkspaceAccess(id, "VIEWER");
  const s = await githubStatus(id);
  const canConnect = ["ADMIN", "OWNER"].includes(role);
  return ok({ ...s, installUrl: s.installUrl && canConnect ? `${s.installUrl}?state=${encodeURIComponent(installState(id, user.userId))}` : null, canConnect });
});
