import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prioritizeBacklog } from "@/lib/workflows/prioritize";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const scored = await prioritizeBacklog(id);
  return ok(scored);
});
