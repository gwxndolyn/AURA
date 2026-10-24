/**
 * Billing application service. Routes call these functions; they talk to the
 * payment provider only through the adapter in ./stripe (replaceable: the
 * functions below need customer/checkout/portal/change/cancel/retrieve, and
 * entitlements come only from verified webhooks or server-side retrieval).
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { audit } from "@/lib/events/emit";
import { PLANS, planOf, downgradeBlockers, PLAN_ORDER, type PlanId, type BillingInterval } from "./plans";
import { subscriptionOf, seatsInUse } from "./entitlements";
import * as provider from "./stripe";

function assertConfigured() {
  if (!provider.billingConfigured().configured) throw new ApiError("Online payments are not configured on this server yet. Ask the operator to set the Stripe keys (see docs/operations/billing.md).", 503);
}

async function usageForDowngrade(companyId: string) {
  const [products, seats, githubConnections] = await Promise.all([
    prisma.product.count({ where: { companyId, status: { notIn: ["CANCELLED", "ARCHIVED"] } } }),
    seatsInUse(companyId),
    prisma.githubInstallation.count({ where: { companyId, status: "ACTIVE" } }),
  ]);
  return { products, seats, githubConnections };
}

/**
 * Start a subscription (Checkout) or change an existing one. Returns either a
 * provider URL the browser should visit, or `{changed: true}` for in-place plan
 * changes. Nothing about the workspace's plan changes here — the webhook does it.
 */
export async function startPlanChange(companyId: string, user: { userId: string; email: string }, plan: PlanId, interval: BillingInterval, origin: string) {
  assertConfigured();
  if (plan === "free") throw new ApiError("To move to the free plan, cancel the subscription (it ends at the close of the paid period)", 422);
  const target = PLANS[plan];
  const blockers = downgradeBlockers(target, await usageForDowngrade(companyId));
  if (blockers.length) throw new ApiError(`Can't switch to ${target.name} yet: ${blockers.join("; ")}.`, 409);
  const sub = await subscriptionOf(companyId);
  const active = sub.stripeSubscriptionId && ["active", "trialing", "past_due"].includes(sub.status) && sub.plan !== "free";
  if (active) {
    if (sub.plan === plan && sub.interval === interval && !sub.cancelAtPeriodEnd) throw new ApiError(`You are already on ${target.name} (${interval === "year" ? "annual" : "monthly"})`, 409);
    await provider.changeSubscriptionPlan({ subscriptionId: sub.stripeSubscriptionId!, plan, interval, idempotencyKey: `change-${companyId}-${plan}-${interval}-${sub.updatedAt.getTime()}` });
    const direction = PLAN_ORDER.indexOf(plan) > PLAN_ORDER.indexOf(planOf(sub.plan).id) ? "upgrade" : "downgrade";
    await audit(companyId, user.email, "SUBSCRIPTION_CHANGE_REQUESTED", plan, `${direction} ${sub.plan} → ${plan} (${interval}); prorated by the provider; applies when confirmed`);
    return { changed: true as const, url: null, note: "The payment provider is applying the change (prorated). Your plan updates as soon as it confirms — usually within seconds." };
  }
  let customer = sub.stripeCustomerId;
  if (!customer) {
    customer = (await provider.createCustomer({ email: user.email, companyId })).id;
    await prisma.subscription.update({ where: { companyId }, data: { stripeCustomerId: customer } });
  }
  const s = await provider.createCheckoutSession({ customer, plan, interval, companyId, successUrl: `${origin}/app/${companyId}/settings?tab=billing&checkout=success`, cancelUrl: `${origin}/app/${companyId}/settings?tab=billing&checkout=cancelled` });
  await audit(companyId, user.email, "CHECKOUT_STARTED", plan, `${interval}; nothing changes until the provider confirms payment`);
  return { changed: false as const, url: s.url, note: null };
}

export async function cancelPlan(companyId: string, actor: string, resume = false) {
  assertConfigured();
  const sub = await subscriptionOf(companyId);
  if (!sub.stripeSubscriptionId || sub.plan === "free") throw new ApiError("There is no paid subscription to cancel", 409);
  await provider.cancelSubscriptionAtPeriodEnd(sub.stripeSubscriptionId, resume);
  await audit(companyId, actor, resume ? "SUBSCRIPTION_RESUME_REQUESTED" : "SUBSCRIPTION_CANCEL_REQUESTED", sub.plan, resume ? "cancellation withdrawn" : `ends ${sub.currentPeriodEnd?.toISOString().slice(0, 10) ?? "at period end"}`);
  return { requested: true, note: resume ? "Your subscription will renew as normal once the provider confirms." : "Your plan stays active until the end of the paid period, then the workspace moves to the free plan." };
}

/**
 * Reconcile from the provider (server-side retrieval). Used after a checkout
 * redirect and by operators — the browser's word is never trusted, but this
 * asks the provider directly, so a delayed webhook does not leave the customer waiting.
 */
export async function syncFromProvider(companyId: string) {
  const sub = await subscriptionOf(companyId);
  if (!sub.stripeSubscriptionId) return { synced: false, reason: "no subscription yet (the checkout webhook has not arrived)" };
  const s = await provider.retrieveSubscription(sub.stripeSubscriptionId);
  const item = s.items?.data?.[0];
  const plan = provider.planForPrice(item?.price?.id) ?? sub.plan;
  const status = s.status === "canceled" ? "canceled" : s.status;
  const end = s.current_period_end ?? item?.current_period_end;
  await prisma.subscription.update({ where: { companyId }, data: { plan: status === "canceled" ? "free" : plan, status, interval: item?.price?.recurring?.interval === "year" ? "year" : "month", cancelAtPeriodEnd: !!s.cancel_at_period_end, currentPeriodEnd: end ? new Date(end * 1000) : sub.currentPeriodEnd, lastEventAt: new Date() } });
  return { synced: true, plan, status };
}

export async function invoicesOf(companyId: string) {
  return prisma.invoice.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 24, select: { id: true, number: true, status: true, currency: true, amountDue: true, amountPaid: true, hostedUrl: true, periodStart: true, periodEnd: true, createdAt: true } });
}
