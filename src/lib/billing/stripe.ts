/**
 * Stripe adapter over the REST API (no SDK dependency). Configured by
 * STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_<PLAN>. Without
 * them, billing reports "not configured" and checkout is unavailable — paid
 * access is never granted without a verified webhook.
 *
 * STRIPE_API_BASE may point at a local test double in automated tests only.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "@/lib/api";
import { resilientFetch, type ProviderHttpError } from "@/lib/resilience/http";
import { PLANS, priceEnvFor, type PlanId, type BillingInterval } from "./plans";

const API = () => process.env.STRIPE_API_BASE || "https://api.stripe.com";

export function billingConfigured() {
  const missing: string[] = [];
  if (!process.env.STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY");
  if (!process.env.STRIPE_WEBHOOK_SECRET) missing.push("STRIPE_WEBHOOK_SECRET");
  for (const p of Object.values(PLANS)) if (p.stripePriceEnv && !process.env[p.stripePriceEnv]) missing.push(p.stripePriceEnv);
  // Annual prices are optional: a plan without one is simply offered monthly only.
  const annual = Object.values(PLANS).filter((p) => p.stripePriceEnvYear && process.env[p.stripePriceEnvYear]).map((p) => p.id);
  return { configured: missing.length === 0, missing, annual, testMode: (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_"), live: (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_live_") };
}

function form(obj: Record<string, string | number | undefined>, prefix = ""): string[] {
  return Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(prefix ? `${prefix}[${k}]` : k)}=${encodeURIComponent(String(v))}`);
}

async function stripe<T>(path: string, body: string[] | null, idempotencyKey?: string): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new ApiError("Billing is not configured on this server (STRIPE_SECRET_KEY)", 503);
  // GETs retry on 429/5xx/timeouts; POSTs retry ONLY with an Idempotency-Key (Stripe dedupes those) — never blindly.
  const r = await resilientFetch(`${API()}${path}`, {
    method: body === null ? "GET" : "POST",
    headers: { Authorization: `Bearer ${key}`, ...(body === null ? {} : { "Content-Type": "application/x-www-form-urlencoded" }), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: body === null ? undefined : body.join("&"),
  }, { provider: "stripe", timeoutMs: 20_000, maxAttempts: 3 }).catch((e) => {
    const k = (e as ProviderHttpError).kind;
    throw new ApiError(k === "rate_limited" ? "The payment provider is rate-limiting requests; try again shortly" : k === "timeout" ? "The payment provider did not respond in time; nothing was charged twice — try again" : `Payment provider unreachable: ${(e as Error).message}`, k === "rate_limited" ? 429 : 502);
  });
  const json = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) throw new ApiError(`Payment provider error: ${json.error?.message ?? r.status}`, r.status >= 500 ? 502 : 400);
  return json;
}

export async function createCustomer(args: { email: string; companyId: string }) {
  return stripe<{ id: string }>("/v1/customers", [...form({ email: args.email }), ...form({ companyId: args.companyId }, "metadata")], `cust-${args.companyId}`);
}

export function priceIdFor(plan: PlanId, interval: BillingInterval) {
  const env = priceEnvFor(PLANS[plan], interval);
  const price = env ? process.env[env] : undefined;
  if (!price) throw new ApiError(interval === "year" ? `Annual billing is not available for the ${PLANS[plan].name} plan on this server` : `The ${PLANS[plan].name} plan is not configured for checkout (${env})`, interval === "year" ? 422 : 503);
  return price;
}

export async function createCheckoutSession(args: { customer: string; plan: PlanId; interval?: BillingInterval; companyId: string; successUrl: string; cancelUrl: string }) {
  const price = priceIdFor(args.plan, args.interval ?? "month");
  return stripe<{ id: string; url: string }>("/v1/checkout/sessions", [
    ...form({ mode: "subscription", customer: args.customer, success_url: args.successUrl, cancel_url: args.cancelUrl, client_reference_id: args.companyId, allow_promotion_codes: "true" }),
    ...form({ price, quantity: 1 }, "line_items[0]"),
    ...form({ companyId: args.companyId, plan: args.plan }, "subscription_data[metadata]"),
    ...form({ companyId: args.companyId, plan: args.plan }, "metadata"),
  ]);
}

interface StripeSubscription { id: string; status: string; customer: string; cancel_at_period_end: boolean; current_period_end?: number; items: { data: { id: string; price: { id: string; recurring?: { interval: string } }; current_period_end?: number }[] } }

/** Server-side retrieval: the source of truth when reconciling (never the browser). */
export async function retrieveSubscription(id: string) {
  return stripe<StripeSubscription>(`/v1/subscriptions/${encodeURIComponent(id)}`, null);
}

/**
 * Change an existing subscription's plan/interval in place. Stripe prorates
 * (create_prorations: the difference is credited/charged on the next invoice).
 * The new entitlements apply when the resulting customer.subscription.updated
 * webhook arrives — not when this call returns.
 */
export async function changeSubscriptionPlan(args: { subscriptionId: string; plan: PlanId; interval: BillingInterval; idempotencyKey: string }) {
  const price = priceIdFor(args.plan, args.interval);
  const sub = await retrieveSubscription(args.subscriptionId);
  const item = sub.items?.data?.[0];
  if (!item) throw new ApiError("The subscription has no items to change", 409);
  return stripe<StripeSubscription>(`/v1/subscriptions/${encodeURIComponent(args.subscriptionId)}`, [
    ...form({ id: item.id, price }, "items[0]"),
    ...form({ proration_behavior: "create_prorations", cancel_at_period_end: "false" }),
    ...form({ plan: args.plan }, "metadata"),
  ], args.idempotencyKey);
}

/** Schedule cancellation at the end of the paid period (access continues until then). */
export async function cancelSubscriptionAtPeriodEnd(subscriptionId: string, resume = false) {
  return stripe<StripeSubscription>(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, form({ cancel_at_period_end: resume ? "false" : "true" }));
}

export async function createPortalSession(args: { customer: string; returnUrl: string }) {
  return stripe<{ url: string }>("/v1/billing_portal/sessions", form({ customer: args.customer, return_url: args.returnUrl }));
}

/**
 * Verify a Stripe-Signature header (t=…,v1=…) against the raw body with
 * STRIPE_WEBHOOK_SECRET; rejects stale timestamps (default 5 min tolerance).
 */
export function verifyWebhook(rawBody: string, header: string | null, secret = process.env.STRIPE_WEBHOOK_SECRET, toleranceSec = 300, now = Date.now()) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  const sigs = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

/** Test helper / documentation of the format: produce a valid signature header. */
export function signWebhook(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

export function planForPrice(priceId: string | undefined | null): PlanId | null {
  if (!priceId) return null;
  for (const p of Object.values(PLANS)) for (const env of [p.stripePriceEnv, p.stripePriceEnvYear]) if (env && process.env[env] === priceId) return p.id;
  return null;
}
