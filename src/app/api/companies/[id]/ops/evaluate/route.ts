import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { runEvaluation } from "@/lib/ops/monitor";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

/** Manual "evaluate now" (still lease-guarded against overlapping runs). */
export const POST = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  return ok(await runEvaluation(id, "manual", { force: true }));
});
