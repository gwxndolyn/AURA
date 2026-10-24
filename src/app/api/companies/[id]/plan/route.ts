import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { planGoal } from "@/lib/workflows/plan";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({ goal: z.string().min(3).max(300) });

export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const { goal } = await parseBody(req, Schema);
  const result = await planGoal(id, goal);
  return ok(result);
});
