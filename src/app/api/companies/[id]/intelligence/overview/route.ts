import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { overview, collaborationSignals } from "@/lib/intelligence/insights";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const [ov, collab] = await Promise.all([overview(id), collaborationSignals(id)]);
  return ok({ ...ov, collaboration: collab });
});
