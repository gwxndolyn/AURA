/**
 * Journey 8 (billing, test mode): checkout through the real route against a
 * Stripe test double; entitlements change ONLY when a correctly signed webhook
 * arrives; invalid/stale signatures are rejected; duplicates are ignored;
 * payment failure → past_due; cancellation → free; quotas enforced server-side.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

let currentToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "aura_session" && currentToken ? { value: currentToken } : undefined), set: () => {} }),
}));

import { prisma } from "@/lib/db";
import { createSessionToken } from "@/lib/auth/session";
import { createCompany } from "@/lib/company/provision";
import * as Checkout from "@/app/api/companies/[id]/billing/checkout/route";
import * as Billing from "@/app/api/companies/[id]/billing/route";
import * as Webhook from "@/app/api/billing/webhook/route";
import { signWebhook, verifyWebhook } from "./stripe";
import { effectivePlan, assertCanStart, recordUsage, QuotaError } from "./entitlements";
import { startStripeDouble } from "../../../test/doubles/stripe";

const SECRET = "whsec_test_secret";
let owner: { id: string; email: string }, member: { id: string; email: string }, ws: string, stripe: Awaited<ReturnType<typeof startStripeDouble>>;
const ctx = (p: Record<string, string>) => ({ params: Promise.resolve(p) as never });
const req = (method: string, body?: unknown, headers: Record<string, string> = {}) => new Request("http://t.local/x", { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const as = async (u: { id: string; email: string } | null) => (currentToken = u ? await createSessionToken({ userId: u.id, email: u.email }) : null);
const hook = async (event: unknown, sig?: string) => {
  const raw = JSON.stringify(event);
  return Webhook.POST(req("POST", raw, { "stripe-signature": sig ?? signWebhook(raw, SECRET) }));
};

beforeAll(async () => {
  stripe = await startStripeDouble();
  Object.assign(process.env, { STRIPE_SECRET_KEY: "sk_test_123", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_TEAM: "price_team", STRIPE_API_BASE: stripe.url });
  const s = Date.now();
  owner = await prisma.user.create({ data: { email: `bill_o_${s}@t.local`, name: "O" } });
  member = await prisma.user.create({ data: { email: `bill_m_${s}@t.local`, name: "M" } });
  ws = (await createCompany({ name: "BILL", mission: "m", industry: "SaaS", ownerId: owner.id })).id;
  await prisma.workspaceMember.create({ data: { userId: member.id, companyId: ws, role: "MEMBER" } });
}, 60_000);

afterAll(async () => {
  await stripe.close();
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRO", "STRIPE_PRICE_TEAM", "STRIPE_API_BASE"]) delete process.env[k];
  if (ws) await prisma.company.deleteMany({ where: { id: ws } });
  await prisma.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
  await prisma.$disconnect();
});

describe("billing", () => {
  it("signature verification rejects tampering, wrong secrets and stale timestamps", () => {
    const raw = '{"id":"evt_1"}';
    expect(verifyWebhook(raw, signWebhook(raw, SECRET), SECRET)).toBe(true);
    expect(verifyWebhook(raw + " ", signWebhook(raw, SECRET), SECRET)).toBe(false);
    expect(verifyWebhook(raw, signWebhook(raw, "other"), SECRET)).toBe(false);
    expect(verifyWebhook(raw, signWebhook(raw, SECRET, Math.floor(Date.now() / 1000) - 3600), SECRET)).toBe(false);
    expect(verifyWebhook(raw, null, SECRET)).toBe(false);
  });

  it("free plan quotas are enforced server-side", async () => {
    expect((await effectivePlan(ws)).plan.id).toBe("free");
    await expect(assertCanStart(ws, "github")).rejects.toBeInstanceOf(QuotaError);
    await recordUsage(ws, [{ metric: "build", quantity: 10 }], "test");
    await expect(assertCanStart(ws, "build")).rejects.toThrow(/Limit reached: 10 of 10 engineering runs this month on the Starter plan/);
  });

  it("checkout: members can't start it; owners get a Stripe URL; nothing changes until the webhook", async () => {
    await as(member);
    expect((await Checkout.POST(req("POST", { plan: "pro" }), ctx({ id: ws }))).status).toBe(403);
    await as(owner);
    const r = await Checkout.POST(req("POST", { plan: "pro" }), ctx({ id: ws }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const session = stripe.calls.find((c) => c.path === "/v1/checkout/sessions")!;
    expect(session.body.get("line_items[0][price]")).toBe("price_pro");
    expect(session.body.get("client_reference_id")).toBe(ws);
    // A client claiming success changes nothing: still free.
    expect((await effectivePlan(ws)).plan.id).toBe("free");
  });

  it("invalid signature → 400 and no change; valid signed events activate Pro once", async () => {
    const sub = await prisma.subscription.findUnique({ where: { companyId: ws } });
    const updated = { id: `evt_sub_${Date.now()}`, type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: sub!.stripeCustomerId, status: "active", current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, cancel_at_period_end: false, items: { data: [{ price: { id: "price_pro" } }] }, metadata: { companyId: ws } } } };
    expect((await hook(updated, "t=1,v1=deadbeef")).status).toBe(400);
    expect((await effectivePlan(ws)).plan.id).toBe("free");
    expect((await hook({ id: `evt_co_${Date.now()}`, type: "checkout.session.completed", data: { object: { client_reference_id: ws, customer: sub!.stripeCustomerId, subscription: "sub_1" } } })).status).toBe(200);
    expect((await hook(updated)).status).toBe(200);
    expect((await (await hook(updated)).json()).data.result).toBe("duplicate");
    const e = await effectivePlan(ws);
    expect(e.plan.id).toBe("pro");
    await expect(assertCanStart(ws, "github")).resolves.toBeUndefined();
    await expect(assertCanStart(ws, "build")).resolves.toBeUndefined(); // 10 used < 150
    await as(owner);
    const b = await (await Billing.GET(req("GET"), ctx({ id: ws }))).json();
    expect(b.data).toMatchObject({ plan: { id: "pro" }, status: "active" });
    expect(b.data.usage.builds).toBe(10);
  });

  it("payment failure → past_due (access kept, notification); cancellation → free", async () => {
    const sub = await prisma.subscription.findUnique({ where: { companyId: ws } });
    await hook({ id: `evt_fail_${Date.now()}`, type: "invoice.payment_failed", data: { object: { id: "in_1", customer: sub!.stripeCustomerId } } });
    expect((await effectivePlan(ws)).status).toBe("past_due");
    expect((await effectivePlan(ws)).plan.id).toBe("pro");
    expect(await prisma.notification.count({ where: { companyId: ws, dedupeKey: "billing-failed:in_1" } })).toBe(1);
    await hook({ id: `evt_del_${Date.now()}`, type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: sub!.stripeCustomerId, status: "canceled", items: { data: [] } } } });
    expect((await effectivePlan(ws)).plan.id).toBe("free");
  });
});
