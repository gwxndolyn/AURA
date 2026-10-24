import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { repos } from "@/lib/integrations/github/service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Repositories the connected GitHub App installation can access. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  return ok(await repos(id));
});
