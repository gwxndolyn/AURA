import { ok, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { cancelCheck } from "@/lib/devspace/checks";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; runId: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, runId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const r = await prisma.execRun.findFirst({ where: { id: runId, companyId: id } });
  if (!r) throw new ApiError("Check not found", 404);
  return ok(r);
});

export const DELETE = handler(async (_req, ctx: Ctx) => {
  const { id, runId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  return ok(await cancelCheck(id, runId, user.email));
});
