import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { effectivePlan, usageThisMonth } from "@/lib/billing/entitlements";
import { billingConfigured } from "@/lib/billing/stripe";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Current plan, subscription state (from verified webhooks), usage this month vs limits. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { role } = await requireWorkspaceAccess(id, "VIEWER");
  const { plan, status, subscription } = await effectivePlan(id);
  const usage = await usageThisMonth(id);
  const products = await prisma.product.count({ where: { companyId: id, status: { not: "CANCELLED" } } });
  const cfg = billingConfigured();
  return ok({
    plan: { id: plan.id, name: plan.name, limits: plan.limits, features: plan.features },
    subscribedPlan: subscription.plan,
    status,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    hasCustomer: !!subscription.stripeCustomerId,
    usage: { ...usage, products },
    billing: { configured: cfg.configured, testMode: cfg.testMode, missing: ["ADMIN", "OWNER"].includes(role) ? cfg.missing : [] },
    canManage: ["ADMIN", "OWNER"].includes(role),
  });
});
