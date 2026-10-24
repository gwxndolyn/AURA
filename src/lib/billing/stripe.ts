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
import { PLANS, type PlanId } from "./plans";

const API = () => process.env.STRIPE_API_BASE || "https://api.stripe.com";

export function billingConfigured() {
  const missing: string[] = [];
  if (!process.env.STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY");
  if (!process.env.STRIPE_WEBHOOK_SECRET) missing.push("STRIPE_WEBHOOK_SECRET");
  for (const p of Object.values(PLANS)) if (p.stripePriceEnv && !process.env[p.stripePriceEnv]) missing.push(p.stripePriceEnv);
  return { configured: missing.length === 0, missing, testMode: (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_") };
}

function form(obj: Record<string, string | number | undefined>, prefix = ""): string[] {
  return Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(prefix ? `${prefix}[${k}]` : k)}=${encodeURIComponent(String(v))}`);
}

async function stripe<T>(path: string, body: string[], idempotencyKey?: string): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new ApiError("Billing is not configured on this server (STRIPE_SECRET_KEY)", 503);
  const r = await fetch(`${API()}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: body.join("&"),
  });
  const json = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) throw new ApiError(`Payment provider error: ${json.error?.message ?? r.status}`, r.status >= 500 ? 502 : 400);
  return json;
}

export async function createCustomer(args: { email: string; companyId: string }) {
  return stripe<{ id: string }>("/v1/customers", [...form({ email: args.email }), ...form({ companyId: args.companyId }, "metadata")], `cust-${args.companyId}`);
}

export async function createCheckoutSession(args: { customer: string; plan: PlanId; companyId: string; successUrl: string; cancelUrl: string }) {
  const priceEnv = PLANS[args.plan].stripePriceEnv;
  const price = priceEnv ? process.env[priceEnv] : undefined;
  if (!price) throw new ApiError(`The ${PLANS[args.plan].name} plan is not configured for checkout (${priceEnv})`, 503);
  return stripe<{ id: string; url: string }>("/v1/checkout/sessions", [
    ...form({ mode: "subscription", customer: args.customer, success_url: args.successUrl, cancel_url: args.cancelUrl, client_reference_id: args.companyId }),
    ...form({ price, quantity: 1 }, "line_items[0]"),
    ...form({ companyId: args.companyId, plan: args.plan }, "subscription_data[metadata]"),
    ...form({ companyId: args.companyId, plan: args.plan }, "metadata"),
  ]);
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
  for (const p of Object.values(PLANS)) if (p.stripePriceEnv && process.env[p.stripePriceEnv] && process.env[p.stripePriceEnv] === priceId) return p.id;
  return null;
}
