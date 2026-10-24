/**
 * Stripe webhook processing. The Subscription row is only ever written here
 * (and by the free default) — a browser redirect to a "success" page grants
 * nothing.
 *
 * Idempotency: one BillingEvent per Stripe event id. An event that was
 * PROCESSED is acknowledged as a duplicate. An event whose processing threw is
 * left processed=false and the handler returns 500, so Stripe's retry runs it
 * again (the earlier implementation acknowledged such retries as duplicates
 * and silently lost them).
 *
 * Ordering: Stripe does not guarantee delivery order. Subscription state is
 * applied only if the event is newer than the last applied one
 * (Subscription.lastEventAt, from the event's `created`).
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/events/emit";
import { log } from "@/lib/observability/log";
import { planForPrice, verifyWebhook } from "./stripe";

interface StripeEvent { id: string; type: string; created?: number; data: { object: Record<string, any> } } // Stripe object shapes vary by event type

const at = (s: number | undefined | null) => (s ? new Date(s * 1000) : null);

async function companyForCustomer(customer: string | undefined, fallback?: string | null) {
  if (customer) {
    const s = await prisma.subscription.findFirst({ where: { stripeCustomerId: customer }, select: { companyId: true } });
    if (s) return s.companyId;
  }
  if (fallback && (await prisma.company.findUnique({ where: { id: fallback }, select: { id: true } }))) return fallback;
  return null;
}

async function apply(ev: StripeEvent): Promise<{ companyId: string | null; detail: string }> {
  const o = ev.data?.object ?? {};
  const created = at(ev.created) ?? new Date();

  if (ev.type === "checkout.session.completed") {
    const companyId = await companyForCustomer(o.customer, o.client_reference_id ?? o.metadata?.companyId ?? null);
    if (!companyId || !o.customer) return { companyId, detail: "checkout without a known workspace" };
    // Checkout completion links the customer/subscription; the plan itself is set by customer.subscription.* events.
    await prisma.subscription.upsert({ where: { companyId }, create: { companyId, stripeCustomerId: o.customer, stripeSubscriptionId: o.subscription ?? null }, update: { stripeCustomerId: o.customer, stripeSubscriptionId: o.subscription ?? undefined } });
    return { companyId, detail: "checkout linked" };
  }

  if (ev.type.startsWith("customer.subscription.")) {
    const sub = await prisma.subscription.findFirst({ where: { OR: [{ stripeSubscriptionId: o.id }, ...(o.customer ? [{ stripeCustomerId: o.customer }] : [])] } });
    const companyId = sub?.companyId ?? (await companyForCustomer(o.customer, o.metadata?.companyId ?? null));
    if (!companyId) return { companyId: null, detail: "subscription for an unknown workspace" };
    if (sub?.lastEventAt && sub.lastEventAt > created) return { companyId, detail: `stale event ignored (newer state from ${sub.lastEventAt.toISOString()} already applied)` };
    const item = o.items?.data?.[0];
    const price = item?.price?.id;
    const interval = item?.price?.recurring?.interval === "year" ? "year" : "month";
    const deleted = ev.type === "customer.subscription.deleted" || o.status === "canceled";
    const plan = deleted ? "free" : (planForPrice(price) ?? (o.metadata?.plan as string | undefined) ?? sub?.plan ?? "free");
    const status = deleted ? "canceled" : String(o.status ?? "incomplete");
    const data = { plan, status, interval, stripeCustomerId: o.customer, stripeSubscriptionId: o.id, currentPeriodEnd: at(o.current_period_end ?? item?.current_period_end), cancelAtPeriodEnd: !!o.cancel_at_period_end, lastEventAt: created };
    await prisma.subscription.upsert({ where: { companyId }, create: { companyId, ...data }, update: data });
    if (sub && sub.plan !== plan) await audit(companyId, "stripe", "SUBSCRIPTION_PLAN_CHANGED", plan, `${sub.plan} → ${plan} (${status})`);
    if (status === "active" || status === "trialing") await prisma.notification.deleteMany({ where: { companyId, dedupeKey: { startsWith: "billing-failed:" } } });
    return { companyId, detail: deleted ? "subscription canceled → free" : `plan ${plan} (${interval}) status ${status}` };
  }

  if (ev.type.startsWith("invoice.")) {
    const companyId = await companyForCustomer(o.customer);
    if (!companyId) return { companyId: null, detail: "invoice for an unknown customer" };
    if (o.id) {
      const data = { number: o.number ?? "", status: String(o.status ?? "open"), currency: String(o.currency ?? "usd"), amountDue: Number(o.amount_due ?? 0), amountPaid: Number(o.amount_paid ?? 0), hostedUrl: typeof o.hosted_invoice_url === "string" && o.hosted_invoice_url.startsWith("https://") ? o.hosted_invoice_url : "", periodStart: at(o.period_start), periodEnd: at(o.period_end) };
      await prisma.invoice.upsert({ where: { id: o.id }, create: { id: o.id, companyId, ...data }, update: data });
    }
    if (ev.type === "invoice.payment_failed") {
      await prisma.subscription.updateMany({ where: { companyId, status: { in: ["active", "trialing"] } }, data: { status: "past_due" } });
      await prisma.notification.upsert({ where: { companyId_dedupeKey: { companyId, dedupeKey: `billing-failed:${o.id}` } }, create: { companyId, dedupeKey: `billing-failed:${o.id}`, kind: "intervention", severity: "high", title: "Payment failed — update your payment method", body: "Your subscription is past due. Paid features stay on while the payment provider retries; if every retry fails the workspace returns to the free plan.", href: "/settings?tab=billing" }, update: {} });
      return { companyId, detail: "payment failed → past_due" };
    }
    if (ev.type === "invoice.paid" || ev.type === "invoice.payment_succeeded") {
      await prisma.subscription.updateMany({ where: { companyId, status: "past_due" }, data: { status: "active" } });
      await prisma.notification.deleteMany({ where: { companyId, dedupeKey: { startsWith: "billing-failed:" } } });
      return { companyId, detail: `invoice ${o.number ?? o.id} paid` };
    }
    return { companyId, detail: `invoice ${o.status ?? "updated"}` };
  }

  return { companyId: null, detail: "ignored" };
}

export async function handleStripeWebhook(rawBody: string, signature: string | null) {
  if (!verifyWebhook(rawBody, signature)) {
    log("warn", "billing.webhook_rejected", { reason: "invalid signature" });
    return { status: 400, message: "invalid signature" };
  }
  let ev: StripeEvent;
  try {
    ev = JSON.parse(rawBody);
  } catch {
    return { status: 400, message: "invalid payload" };
  }
  if (!ev?.id || !ev.type) return { status: 400, message: "invalid payload" };

  const prior = await prisma.billingEvent.findUnique({ where: { id: ev.id } });
  if (prior?.processed) return { status: 200, message: "duplicate" };
  if (!prior) {
    try {
      await prisma.billingEvent.create({ data: { id: ev.id, type: ev.type } });
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
    }
  }
  // Claim this attempt (concurrent deliveries of the same event: one processes, the other sees processed/claimed).
  const claimedBefore = prior?.attempts ?? 0;
  const claim = await prisma.billingEvent.updateMany({ where: { id: ev.id, processed: false, attempts: claimedBefore }, data: { attempts: { increment: 1 } } });
  if (!claim.count) return { status: 200, message: "duplicate" };

  try {
    const { companyId, detail } = await apply(ev);
    await prisma.billingEvent.update({ where: { id: ev.id }, data: { processed: true, companyId, detail, error: "" } });
    if (companyId) await audit(companyId, "stripe", "BILLING_EVENT", ev.type, detail);
    log("info", "billing.webhook", { eventId: ev.id, type: ev.type, companyId, detail });
    return { status: 200, message: detail };
  } catch (e) {
    const message = (e as Error).message.slice(0, 1000);
    await prisma.billingEvent.update({ where: { id: ev.id }, data: { error: message } }).catch(() => null);
    log("error", "billing.webhook_failed", { eventId: ev.id, type: ev.type, error: message });
    // 500 → Stripe retries with backoff; the next delivery re-runs apply().
    return { status: 500, message: "processing failed; will be retried" };
  }
}
