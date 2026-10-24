import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { buildBriefing } from "@/lib/ops/briefing";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Deterministic operational briefing built from persisted findings and state. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  return ok(await buildBriefing(id));
});
