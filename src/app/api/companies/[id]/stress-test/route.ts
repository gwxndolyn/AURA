import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { runStressTest } from "@/lib/workflows/stressTest";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

/** Run the full autonomous stress test (all failure modes) and return a report. */
export const POST = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const result = await runStressTest(id);
  return ok(result);
});
