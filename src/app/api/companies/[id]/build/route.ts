import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { buildGoal } from "@/lib/workflows/build";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({ goal: z.string().min(3).max(300).default("Build the MVP") });

export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const { goal } = await parseBody(req, Schema);
  const result = await buildGoal(id, goal);
  return ok({
    projectId: result.plan.projectId,
    strategy: result.plan.strategy,
    tasksDone: result.results.filter((r) => r.status === "DONE").length,
    tasksTotal: result.results.length,
    deploy: { success: result.deploy.success, version: result.deploy.version },
  });
});
