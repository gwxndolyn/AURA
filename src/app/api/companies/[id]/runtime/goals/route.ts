import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { assertFeature } from "@/lib/billing/entitlements";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { createGoal, GOAL_KINDS, GOAL_MODES, MODE_ROLE } from "@/lib/runtime/goals";
import { createSchedule } from "@/lib/runtime/schedule";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const rows = await prisma.goal.findMany({ where: { companyId: id }, orderBy: { createdAt: "desc" }, take: 100 });
  return ok(rows.map((g) => ({ ...g, plan: parseJSON(g.plan, []), acceptance: parseJSON(g.acceptance, []), limits: parseJSON(g.limits, {}), usage: parseJSON(g.usage, {}), checkpoint: parseJSON(g.checkpoint, {}) })));
});

const Body = z.object({
  kind: z.enum(GOAL_KINDS), mode: z.enum(GOAL_MODES), request: z.string().max(4000).default(""), title: z.string().max(120).optional(), productId: z.string().max(40).optional(),
  limits: z.object({ maxAdvances: z.number(), maxWallMs: z.number(), maxCostUsd: z.number(), maxModelCalls: z.number(), maxConsecutiveFailures: z.number(), pollMs: z.number() }).partial().optional(),
  schedule: z.string().max(80).optional(), // recurring/deferred: creates a Schedule that submits this goal
});

/** Submit a goal (the mode decides the minimum role: SUPERVISED=MEMBER, AUTONOMOUS_DEV/CONTINUOUS_IMPROVEMENT=ADMIN, PRODUCTION_OPS=OWNER). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const b = await parseBody(req, Body);
  const { user } = await requireWorkspaceAccess(id, MODE_ROLE[b.mode]);
  await assertFeature(id, "advanced_agents");
  if (b.schedule) {
    const s = await createSchedule({ companyId: id, name: b.title ?? `${b.kind} (${b.mode})`, jobType: "goal.submit", payload: { kind: b.kind, mode: b.mode, request: b.request, title: b.title, productId: b.productId, limits: b.limits, userId: user.userId, email: user.email }, spec: b.schedule, createdBy: user.email });
    return ok({ scheduled: true, scheduleId: s.id, nextRunAt: s.nextRunAt }, { status: 201 });
  }
  const g = await createGoal({ companyId: id, userId: user.userId, email: user.email, kind: b.kind, mode: b.mode, request: b.request, title: b.title, productId: b.productId, limits: b.limits });
  return ok(g, { status: 201 });
});
