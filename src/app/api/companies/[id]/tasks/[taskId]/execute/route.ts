import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { executeTask } from "@/lib/workflows/executeTask";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string; taskId: string }> };

/** Run an AI agent to execute a task through the quality gate. */
export const POST = handler(async (_req, ctx: Ctx) => {
  const { id, taskId } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const result = await executeTask(id, taskId);
  return ok(result);
});
