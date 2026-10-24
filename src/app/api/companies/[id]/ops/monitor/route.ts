import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/events/emit";
import { getMonitor, runEvaluation, MIN_INTERVAL_SEC } from "@/lib/ops/monitor";
import { POLICY_LEVELS, ACTIONS, ACTION_TYPES } from "@/lib/ops/actions";
import { RULES, DEFAULT_THRESHOLDS } from "@/lib/ops/rules";
import { parseJSON } from "@/lib/utils";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const m = await getMonitor(id);
  const runs = await prisma.opsEvaluation.findMany({ where: { companyId: id }, orderBy: { startedAt: "desc" }, take: 10 });
  return ok({
    ...m,
    leaseOwner: undefined,
    allowedAutoActions: parseJSON<string[]>(m.allowedAutoActions, []),
    thresholds: { ...DEFAULT_THRESHOLDS, ...parseJSON(m.thresholds, {}) },
    actions: Object.values(ACTIONS),
    rules: RULES.map((r) => ({ id: r.id, version: r.version, category: r.category, title: r.title, definition: r.definition })),
    runs: runs.map((r) => ({ ...r, unknown: parseJSON<unknown[]>(r.unknown, []) })),
  });
});

const Schema = z.object({
  enabled: z.boolean().optional(),
  intervalSec: z.number().int().min(MIN_INTERVAL_SEC).max(86_400).optional(),
  policyLevel: z.enum(POLICY_LEVELS).optional(),
  allowedAutoActions: z.array(z.enum(ACTION_TYPES)).max(10).optional(),
  maxAutoActionsPerHour: z.number().int().min(0).max(30).optional(),
  notifyMinSeverity: z.enum(["low", "medium", "high", "critical"]).optional(),
  aiSummaries: z.boolean().optional(),
});

/** Monitor + autonomy policy. ADMIN only; automatic actions are limited to auto-eligible low-risk types. */
export const PUT = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const body = await parseBody(req, Schema);
  const allowed = body.allowedAutoActions?.filter((a) => ACTIONS[a].autoEligible && ACTIONS[a].risk === "low");
  await getMonitor(id);
  const { allowedAutoActions: _raw, ...rest } = body;
  const m = await prisma.opsMonitor.update({ where: { companyId: id }, data: { ...rest, ...(allowed ? { allowedAutoActions: JSON.stringify(allowed) } : {}), updatedBy: user.email } });
  await audit(id, user.email, "OPS_POLICY_UPDATED", id, JSON.stringify({ ...body, allowedAutoActions: allowed }));
  return ok({ ...m, allowedAutoActions: parseJSON<string[]>(m.allowedAutoActions, []) });
});

/** Scheduled reconciliation heartbeat from the app shell: runs only if the interval has elapsed. */
export const POST = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  return ok(await runEvaluation(id, "scheduled"));
});
