/**
 * Stripe webhook processing. Idempotent per event id (BillingEvent). The
 * subscription row is only ever written here (and by the free default).
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/events/emit";
import { log } from "@/lib/observability/log";
import { planForPrice, verifyWebhook } from "./stripe";

interface StripeEvent { id: string; type: string; data: { object: Record<string, any> } } // Stripe object shapes vary by event type

export async function handleStripeWebhook(rawBody: string, signature: string | null) {
  if (!verifyWebhook(rawBody, signature)) return { status: 400, message: "invalid signature" };
  let ev: StripeEvent;
  try {
    ev = JSON.parse(rawBody);
  } catch {
    return { status: 400, message: "invalid payload" };
  }
  if (await prisma.billingEvent.findUnique({ where: { id: ev.id } })) return { status: 200, message: "duplicate" };
  try {
    await prisma.billingEvent.create({ data: { id: ev.id, type: ev.type } });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { status: 200, message: "duplicate" };
    throw e;
  }
  const o = ev.data?.object ?? {};
  let companyId: string | null = null;
  let detail = "ignored";
  if (ev.type === "checkout.session.completed") {
    companyId = o.client_reference_id ?? o.metadata?.companyId ?? null;
    if (companyId && o.customer) {
      await prisma.subscription.upsert({ where: { companyId }, create: { companyId, stripeCustomerId: o.customer, stripeSubscriptionId: o.subscription ?? null }, update: { stripeCustomerId: o.customer, stripeSubscriptionId: o.subscription ?? undefined } });
      detail = "checkout linked";
    }
  } else if (ev.type.startsWith("customer.subscription.")) {
    const sub = await prisma.subscription.findFirst({ where: { OR: [{ stripeSubscriptionId: o.id }, { stripeCustomerId: o.customer }] } });
    companyId = sub?.companyId ?? o.metadata?.companyId ?? null;
    if (companyId) {
      const price = o.items?.data?.[0]?.price?.id;
      const plan = planForPrice(price) ?? (o.metadata?.plan as string | undefined) ?? sub?.plan ?? "free";
      const deleted = ev.type === "customer.subscription.deleted";
      await prisma.subscription.upsert({
        where: { companyId },
        create: { companyId, plan: deleted ? "free" : plan, status: deleted ? "canceled" : o.status, stripeCustomerId: o.customer, stripeSubscriptionId: o.id, currentPeriodEnd: o.current_period_end ? new Date(o.current_period_end * 1000) : null, cancelAtPeriodEnd: !!o.cancel_at_period_end },
        update: { plan: deleted ? "free" : plan, status: deleted ? "canceled" : o.status, stripeCustomerId: o.customer, stripeSubscriptionId: o.id, currentPeriodEnd: o.current_period_end ? new Date(o.current_period_end * 1000) : null, cancelAtPeriodEnd: !!o.cancel_at_period_end },
      });
      detail = deleted ? "subscription canceled → free" : `plan ${plan} status ${o.status}`;
    }
  } else if (ev.type === "invoice.payment_failed") {
    const sub = await prisma.subscription.findFirst({ where: { stripeCustomerId: o.customer } });
    companyId = sub?.companyId ?? null;
    if (sub) {
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: "past_due" } });
      await prisma.notification.upsert({ where: { companyId_dedupeKey: { companyId: sub.companyId, dedupeKey: `billing-failed:${o.id}` } }, create: { companyId: sub.companyId, dedupeKey: `billing-failed:${o.id}`, kind: "intervention", severity: "high", title: "Payment failed — update your payment method", body: "Your subscription is past due. Paid features stay on while the payment provider retries.", href: "/settings?tab=billing" }, update: {} });
      detail = "payment failed → past_due";
    }
  }
  await prisma.billingEvent.update({ where: { id: ev.id }, data: { processed: true, companyId, detail } });
  if (companyId) await audit(companyId, "stripe", "BILLING_EVENT", ev.type, detail);
  log("info", "billing.webhook", { eventId: ev.id, type: ev.type, companyId, detail });
  return { status: 200, message: detail };
}
