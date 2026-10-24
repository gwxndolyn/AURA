/**
 * Entitlements and usage metering. Server-side only: limits are evaluated from
 * the persisted Subscription (written by verified Stripe webhooks) and the
 * UsageEvent ledger — never from anything the browser says.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { planOf, ENTITLED_STATUSES, type Plan } from "./plans";

export class QuotaError extends ApiError {
  constructor(message: string, public limit: string) {
    super(message, 402);
    this.name = "QuotaError";
  }
}

export async function subscriptionOf(companyId: string) {
  return prisma.subscription.upsert({ where: { companyId }, create: { companyId }, update: {} });
}

/** The plan whose entitlements currently apply (free if the paid subscription isn't in good standing). */
export async function effectivePlan(companyId: string): Promise<{ plan: Plan; status: string; subscription: Awaited<ReturnType<typeof subscriptionOf>> }> {
  const sub = await subscriptionOf(companyId);
  const paidOk = ENTITLED_STATUSES.includes(sub.status);
  return { plan: planOf(paidOk ? sub.plan : "free"), status: sub.status, subscription: sub };
}

const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export async function recordUsage(companyId: string, entries: { metric: string; quantity: number }[], source: string) {
  const rows = entries.filter((e) => Number.isFinite(e.quantity) && e.quantity > 0).map((e) => ({ companyId, metric: e.metric, quantity: e.quantity, source }));
  if (rows.length) await prisma.usageEvent.createMany({ data: rows });
}

export async function usageThisMonth(companyId: string) {
  const rows = await prisma.usageEvent.groupBy({ by: ["metric"], where: { companyId, createdAt: { gte: monthStart() } }, _sum: { quantity: true } });
  const get = (m: string) => rows.find((r) => r.metric === m)?._sum.quantity ?? 0;
  return {
    since: monthStart().toISOString(),
    builds: get("build"),
    aiCostUsd: get("ai_cost_usd"),
    tokensIn: get("ai_tokens_in"),
    tokensOut: get("ai_tokens_out"),
    sandboxMinutes: get("sandbox_ms") / 60_000,
  };
}

/** Throws QuotaError (402) when starting this kind of work would exceed the plan. */
export async function assertCanStart(companyId: string, what: "product" | "build" | "github" | "pull_request" | "deploy_request") {
  const { plan } = await effectivePlan(companyId);
  if (what === "github" && !plan.features.githubIntegration) throw new QuotaError(`GitHub integration is available on paid plans (current plan: ${plan.name})`, "githubIntegration");
  if (what === "pull_request" && !plan.features.pullRequests) throw new QuotaError(`Pull requests are available on paid plans (current plan: ${plan.name})`, "pullRequests");
  if (what === "deploy_request" && !plan.features.deploymentRequests) throw new QuotaError(`Deployment requests are available on paid plans (current plan: ${plan.name})`, "deploymentRequests");
  if (what === "product") {
    const n = await prisma.product.count({ where: { companyId, status: { not: "CANCELLED" } } });
    if (n >= plan.limits.products) throw new QuotaError(`Your ${plan.name} plan includes ${plan.limits.products} active product(s). Upgrade or cancel a product to create another.`, "products");
  }
  if (what === "build") {
    const u = await usageThisMonth(companyId);
    if (u.builds >= plan.limits.buildsPerMonth) throw new QuotaError(`Monthly engineering-run limit reached (${plan.limits.buildsPerMonth} on ${plan.name}).`, "buildsPerMonth");
    if (u.aiCostUsd >= plan.limits.aiBudgetUsdPerMonth) throw new QuotaError(`Monthly AI budget reached ($${plan.limits.aiBudgetUsdPerMonth} on ${plan.name}).`, "aiBudgetUsdPerMonth");
    if (u.sandboxMinutes >= plan.limits.sandboxMinutesPerMonth) throw new QuotaError(`Monthly sandbox minutes reached (${plan.limits.sandboxMinutesPerMonth} on ${plan.name}).`, "sandboxMinutesPerMonth");
    const running = await prisma.build.count({ where: { companyId, status: { in: ["QUEUED", "RUNNING"] } } });
    if (running >= plan.limits.concurrentBuilds) throw new QuotaError(`Your plan runs ${plan.limits.concurrentBuilds} engineering run(s) at a time; wait for the current one to finish.`, "concurrentBuilds");
  }
}

/** Remaining AI budget for this month (USD) — the hard stop the builder checks before each model turn. */
export async function remainingAiBudget(companyId: string) {
  const { plan } = await effectivePlan(companyId);
  const u = await usageThisMonth(companyId);
  return Math.max(0, plan.limits.aiBudgetUsdPerMonth - u.aiCostUsd);
}
