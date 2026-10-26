import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess, requirePermission } from "@/lib/auth/authz";
import { audit } from "@/lib/events/emit";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { ExecutionPolicySchema, getExecutionPolicy, setExecutionPolicy, strategyMetrics } from "@/lib/builder/planner";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/** Adaptive execution: the project's policy, the persisted plan of recent runs (decisions + evidence), and strategy metrics. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const policy = await getExecutionPolicy(id, productId); // 404 for another workspace's product
  const runs = await prisma.build.findMany({
    where: { companyId: id, productId, executionPlan: { not: "{}" } },
    orderBy: { createdAt: "desc" }, take: 30,
    select: { id: true, itemKey: true, status: true, attempt: true, costUsd: true, modelCalls: true, stopReason: true, adaptivePolicy: true, executionPlan: true, createdAt: true },
  });
  return ok({ ...policy, runs: runs.map(({ executionPlan, ...r }) => ({ ...r, plan: parseJSON<Record<string, unknown>>(executionPlan, {}) })), metrics: await strategyMetrics(id, productId) });
});

/** Change or roll back the execution policy (ADMIN). Applies to runs started afterwards. */
export const PATCH = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requirePermission(id, "workspace.settings");
  const input = await parseBody(req, ExecutionPolicySchema);
  const next = await setExecutionPolicy(id, productId, input);
  await audit(id, user.email, "PRODUCT_EXECUTION_POLICY", productId, JSON.stringify(next).slice(0, 400), { category: "execution" });
  return ok({ policy: next });
});
