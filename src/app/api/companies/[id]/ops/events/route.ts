import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { recentOpsEvents } from "@/lib/ops/read";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const u = new URL(req.url);
  const hours = Number(u.searchParams.get("hours") ?? 0);
  return ok(await recentOpsEvents(id, { severity: u.searchParams.get("severity")?.split(",").filter(Boolean), since: hours > 0 ? new Date(Date.now() - hours * 3600_000) : undefined }));
});
