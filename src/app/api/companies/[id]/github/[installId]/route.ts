import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { disconnect } from "@/lib/integrations/github/service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; installId: string }> };

export const DELETE = handler(async (_req, ctx: Ctx) => {
  const { id, installId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  return ok(await disconnect(id, user.email, installId));
});
