import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { companyTimeline } from "@/lib/twin/timeline";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const q = new URL(req.url).searchParams;
  const s = (k: string) => q.get(k)?.slice(0, 40) || undefined;
  return ok(await companyTimeline(id, { dept: s("dept"), provenance: s("provenance"), runId: s("run"), missionId: s("mission"), type: s("type"), hours: Number(q.get("hours") ?? 0) }));
});
