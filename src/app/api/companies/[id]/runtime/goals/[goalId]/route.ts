import { z } from "zod";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { controlGoal, MODE_ROLE, type GoalMode } from "@/lib/runtime/goals";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; goalId: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, goalId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const g = await prisma.goal.findFirst({ where: { id: goalId, companyId: id } });
  if (!g) throw new ApiError("Goal not found", 404);
  const jobs = await prisma.job.findMany({ where: { companyId: id, goalId }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, type: true, status: true, attempts: true, runAt: true, startedAt: true, finishedAt: true, lastError: true, errorKind: true, workerId: true, progress: true } });
  const events = await prisma.jobEvent.findMany({ where: { companyId: id, jobId: { in: jobs.map((j) => j.id) } }, orderBy: { createdAt: "desc" }, take: 200 });
  return ok({ ...g, plan: parseJSON(g.plan, []), acceptance: parseJSON(g.acceptance, []), limits: parseJSON(g.limits, {}), usage: parseJSON(g.usage, {}), checkpoint: parseJSON(g.checkpoint, {}), jobs, events });
});

/** pause / resume (optionally with new limits) / cancel — same role the goal's mode required to submit it. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, goalId } = await ctx.params;
  const g = await prisma.goal.findFirst({ where: { id: goalId, companyId: id }, select: { mode: true } });
  const { user } = await requireWorkspaceAccess(id, g ? MODE_ROLE[g.mode as GoalMode] : "MEMBER");
  if (!g) throw new ApiError("Goal not found", 404);
  const b = await parseBody(req, z.object({ action: z.enum(["pause", "resume", "cancel"]), limits: z.object({ maxAdvances: z.number(), maxWallMs: z.number(), maxCostUsd: z.number(), maxModelCalls: z.number(), maxConsecutiveFailures: z.number(), pollMs: z.number() }).partial().optional() }));
  return ok(await controlGoal(id, goalId, b.action, user.email, b.limits));
});
