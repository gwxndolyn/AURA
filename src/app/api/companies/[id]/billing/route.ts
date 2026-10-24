import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess, roleAllows } from "@/lib/auth/authz";
import { effectivePlan, usageThisMonth, seatsInUse } from "@/lib/billing/entitlements";
import { billingConfigured } from "@/lib/billing/stripe";
import { invoicesOf } from "@/lib/billing/service";
import { PLANS, PLAN_ORDER } from "@/lib/billing/plans";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Current plan, subscription state (from verified webhooks), usage vs limits, invoices (billing managers only). */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { role } = await requireWorkspaceAccess(id, "VIEWER");
  const canManage = roleAllows(role, "billing.manage");
  const { plan, status, subscription } = await effectivePlan(id);
  const [usage, products, seats, company] = await Promise.all([
    usageThisMonth(id),
    prisma.product.count({ where: { companyId: id, status: { notIn: ["CANCELLED", "ARCHIVED"] } } }),
    seatsInUse(id),
    prisma.company.findUnique({ where: { id }, select: { monthlyBudgetUsd: true } }),
  ]);
  const cfg = billingConfigured();
  return ok({
    plan: { id: plan.id, name: plan.name, limits: plan.limits, features: plan.features },
    subscribedPlan: subscription.plan,
    interval: subscription.interval,
    status,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    hasCustomer: !!subscription.stripeCustomerId,
    hasSubscription: !!subscription.stripeSubscriptionId && subscription.plan !== "free",
    usage: { ...usage, products, seats },
    spendingCapUsd: company?.monthlyBudgetUsd ?? null,
    catalogue: PLAN_ORDER.map((pid) => ({ id: pid, name: PLANS[pid].name, priceUsd: PLANS[pid].priceUsd, priceUsdYear: PLANS[pid].priceUsdYear, highlights: PLANS[pid].highlights, annualAvailable: cfg.annual.includes(pid) })),
    billing: { configured: cfg.configured, testMode: cfg.testMode, live: cfg.live, missing: canManage ? cfg.missing : [] },
    invoices: canManage ? await invoicesOf(id) : [],
    canManage,
  });
});
