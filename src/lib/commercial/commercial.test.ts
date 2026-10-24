/**
 * V8 commercial acceptance suite. Runs the REAL route handlers, authz,
 * entitlement/ledger code and database (SQLite). External providers:
 *   - Stripe: HTTP test double (test/doubles/stripe.ts) — proves our request
 *     shapes, signature verification and state machine, NOT live Stripe.
 *   - Email: not configured → outbox rows only (devLink returned in test env).
 * Sessions are real signed tokens validated by the real getSession() (cookie
 * store mocked, since there is no browser).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { value: jar.get(n)! } : undefined),
    set: (n: string, v: string, o?: { maxAge?: number }) => (o?.maxAge === 0 || !v ? jar.delete(n) : jar.set(n, v)),
  }),
}));

import { prisma } from "@/lib/db";
import { createSessionToken, validateSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { createCompany } from "@/lib/company/provision";
import { resetRateLimits } from "@/lib/auth/rateLimit";
import { csrfViolation } from "@/lib/auth/csrf";
import { PERMISSIONS, roleAllows } from "@/lib/auth/authz";
import { reserve, settle, recordUsage, recoverReservations, usageThisMonth, reconcileCounters, effectivePlan, QuotaError, periodOf } from "@/lib/billing/entitlements";
import { signWebhook } from "@/lib/billing/stripe";
import { redactText } from "@/lib/security/redact";
import { encrypt, decrypt } from "@/lib/security/secrets";
import { startBuild } from "@/lib/builder/service";
import { createProduct } from "@/lib/factory/store";
import { outboxCopy } from "@/lib/email/send";
import { startStripeDouble } from "../../../test/doubles/stripe";

import * as Register from "@/app/api/auth/register/route";
import * as Login from "@/app/api/auth/login/route";
import * as Logout from "@/app/api/auth/logout/route";
import * as Reset from "@/app/api/auth/password-reset/route";
import * as Password from "@/app/api/auth/password/route";
import * as Verify from "@/app/api/auth/verify-email/route";
import * as Me from "@/app/api/auth/me/route";
import * as Account from "@/app/api/auth/account/route";
import * as Companies from "@/app/api/companies/route";
import * as Company from "@/app/api/companies/[id]/route";
import * as Members from "@/app/api/companies/[id]/members/route";
import * as Invitations from "@/app/api/companies/[id]/members/invitations/route";
import * as Member from "@/app/api/companies/[id]/members/[userId]/route";
import * as Transfer from "@/app/api/companies/[id]/members/transfer/route";
import * as AcceptInvite from "@/app/api/invitations/route";
import * as Products from "@/app/api/companies/[id]/products/route";
import * as Product from "@/app/api/companies/[id]/products/[productId]/route";
import * as Download from "@/app/api/companies/[id]/products/[productId]/download/route";
import * as Archive from "@/app/api/companies/[id]/products/[productId]/archive/route";
import * as Deploy from "@/app/api/companies/[id]/products/[productId]/deploy/route";
import * as Secrets from "@/app/api/companies/[id]/secrets/route";
import * as Export from "@/app/api/companies/[id]/export/route";
import * as AuditLog from "@/app/api/companies/[id]/audit-log/route";
import * as Billing from "@/app/api/companies/[id]/billing/route";
import * as Checkout from "@/app/api/companies/[id]/billing/checkout/route";
import * as Cancel from "@/app/api/companies/[id]/billing/cancel/route";
import * as Sync from "@/app/api/companies/[id]/billing/sync/route";
import * as Webhook from "@/app/api/billing/webhook/route";
import * as Jobs from "@/app/api/companies/[id]/runtime/jobs/route";
import * as Stream from "@/app/api/companies/[id]/stream/route";
import * as GithubDisconnect from "@/app/api/companies/[id]/github/[installId]/route";
import * as Admin from "@/app/api/admin/overview/route";

const SECRET = "whsec_commercial_test";
const stamp = Date.now();
const T0 = Math.floor(stamp / 1000) - 3600; // provider event timestamps (seconds), in the recent past
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) as never });
const req = (method = "GET", body?: unknown, headers: Record<string, string> = {}) => new Request("http://t.local/x", { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const none = { params: Promise.resolve({}) } as never;
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
type U = { id: string; email: string };
const users: Record<string, U> = {};
const signIn = async (u: U | null) => {
  jar.clear();
  if (u) jar.set(SESSION_COOKIE, await createSessionToken({ userId: u.id, email: u.email }));
};
const hook = async (event: unknown) => {
  const raw = JSON.stringify(event);
  return Webhook.POST(req("POST", raw, { "stripe-signature": signWebhook(raw, SECRET) }));
};
let wsA = "", wsB = "", productA = "", stripe: Awaited<ReturnType<typeof startStripeDouble>>;
const created: string[] = [];

beforeAll(async () => {
  stripe = await startStripeDouble();
  Object.assign(process.env, { STRIPE_SECRET_KEY: "sk_test_commercial", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_PRO: "price_pro_m", STRIPE_PRICE_TEAM: "price_team_m", STRIPE_PRICE_PRO_YEARLY: "price_pro_year", STRIPE_API_BASE: stripe.url, AURA_SECRETS_KEY: Buffer.alloc(32, 7).toString("base64") });
  for (const n of ["owner", "admin", "dev", "viewer", "outsider", "invitee"]) {
    users[n] = await prisma.user.create({ data: { email: `v8_${n}_${stamp}@t.local`, name: n } });
    created.push(users[n].id);
  }
  wsA = (await createCompany({ name: `V8-A-${stamp}`, mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
  wsB = (await createCompany({ name: `V8-B-${stamp}`, mission: "m", industry: "SaaS", ownerId: users.outsider.id })).id;
  // Team plan for A so seat limits leave room for the role tests.
  await prisma.subscription.create({ data: { companyId: wsA, plan: "team", status: "active" } });
  for (const [n, role] of [["admin", "ADMIN"], ["dev", "MEMBER"], ["viewer", "VIEWER"]] as const) await prisma.workspaceMember.create({ data: { userId: users[n].id, companyId: wsA, role } });
  const p = await createProduct({ companyId: wsA, userId: users.owner.id, actor: users.owner.email, idea: "A small task tracker with projects, tasks and priorities that persists data." });
  productA = p.product.id;
}, 120_000);

afterAll(async () => {
  await stripe.close();
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRO", "STRIPE_PRICE_TEAM", "STRIPE_PRICE_PRO_YEARLY", "STRIPE_API_BASE", "AURA_SECRETS_KEY"]) delete process.env[k];
  await prisma.company.deleteMany({ where: { OR: [{ id: { in: [wsA, wsB] } }, { ownerId: { in: created } }] } });
  await prisma.user.deleteMany({ where: { OR: [{ id: { in: created } }, { email: { startsWith: `v8_signup_${stamp}` } }] } });
  await prisma.$disconnect();
});

describe("tenant isolation (real routes)", () => {
  it("an outsider gets 404 — not 403 — on every kind of resource in another tenant", async () => {
    await signIn(users.outsider);
    const p = ctx({ id: wsA });
    const pp = ctx({ id: wsA, productId: productA });
    const results = await Promise.all([
      Company.GET(req(), p),
      Products.GET(req(), p),
      Product.GET(req(), pp),
      Download.GET(req(), pp), // artifact download
      Deploy.POST(req("POST", { action: "deploy", env: "preview" }), pp), // deploy
      Secrets.GET(req(), p),
      Export.GET(req(), p), // export
      AuditLog.GET(req(), p),
      Billing.GET(req(), p),
      Members.GET(req(), p),
      Jobs.GET(req(), p), // background jobs
      Stream.GET(req(), p), // realtime
      Archive.POST(req("POST", { action: "archive" }), pp),
      Company.DELETE(req("DELETE"), p),
    ]);
    expect(results.map((r) => r.status)).toEqual(Array(results.length).fill(404));
  });

  it("a nested id from tenant A addressed through tenant B's URL is not found (IDOR)", async () => {
    await signIn(users.outsider);
    expect((await Product.GET(req(), ctx({ id: wsB, productId: productA }))).status).toBe(404);
    expect((await Download.GET(req(), ctx({ id: wsB, productId: productA }))).status).toBe(404);
    expect((await Archive.POST(req("POST", { action: "archive" }), ctx({ id: wsB, productId: productA }))).status).toBe(404);
  });

  it("client-supplied workspace ids grant nothing: the session decides membership", async () => {
    await signIn(users.dev);
    const list = (await json(await Companies.GET(req(), none))).body.data.map((c: { id: string }) => c.id);
    expect(list).toContain(wsA);
    expect(list).not.toContain(wsB);
  });

  it("unauthenticated requests are 401", async () => {
    await signIn(null);
    expect((await Company.GET(req(), ctx({ id: wsA }))).status).toBe(401);
    expect((await Products.GET(req(), ctx({ id: wsA }))).status).toBe(401);
  });

  it("background work keeps tenant scope: a build cannot be started for another tenant's product", async () => {
    await expect(startBuild({ companyId: wsB, productId: productA, itemKey: "T1", actor: "x", maxRepairs: 0 })).rejects.toThrow();
    expect(await prisma.build.count({ where: { companyId: wsB } })).toBe(0);
  });
});

describe("roles and permissions", () => {
  it("permission matrix: viewer reads only; developer executes; admin manages; owner deletes", () => {
    expect(roleAllows("VIEWER", "workspace.read")).toBe(true);
    expect(roleAllows("VIEWER", "execution.start")).toBe(false);
    expect(roleAllows("MEMBER", "execution.start")).toBe(true);
    expect(roleAllows("MEMBER", "deploy.production")).toBe(false);
    expect(roleAllows("MEMBER", "billing.manage")).toBe(false);
    expect(roleAllows("ADMIN", "secret.manage")).toBe(true);
    expect(roleAllows("ADMIN", "workspace.delete")).toBe(false);
    expect(roleAllows("OWNER", "workspace.delete")).toBe(true);
    for (const p of Object.keys(PERMISSIONS)) expect(roleAllows("OWNER", p as keyof typeof PERMISSIONS)).toBe(true);
  });

  it("the backend enforces roles on real routes (and records denials)", async () => {
    await signIn(users.viewer);
    expect((await Products.POST(req("POST", { idea: "Another product idea with enough characters to pass." }), ctx({ id: wsA }))).status).toBe(403);
    expect((await Export.GET(req(), ctx({ id: wsA }))).status).toBe(403);
    await signIn(users.dev);
    expect((await Secrets.PUT(req("PUT", { name: "API_TOKEN", value: "x" }), ctx({ id: wsA }))).status).toBe(403);
    expect((await Checkout.POST(req("POST", { plan: "pro" }), ctx({ id: wsA }))).status).toBe(403);
    expect((await Invitations.POST(req("POST", { email: "x@t.local" }), ctx({ id: wsA }))).status).toBe(403);
    expect((await Company.DELETE(req("DELETE"), ctx({ id: wsA }))).status).toBe(403);
    await signIn(users.admin);
    expect((await Company.DELETE(req("DELETE"), ctx({ id: wsA }))).status).toBe(403);
    expect(await prisma.auditLog.count({ where: { companyId: wsA, action: "ACCESS_DENIED", outcome: "denied" } })).toBeGreaterThanOrEqual(5);
  });

  it("privilege escalation is refused: no self-promotion, admins cannot mint admins, OWNER is never granted", async () => {
    await signIn(users.dev);
    expect((await Member.PATCH(req("PATCH", { role: "ADMIN" }), ctx({ id: wsA, userId: users.dev.id }))).status).toBe(403);
    await signIn(users.admin);
    expect((await Member.PATCH(req("PATCH", { role: "ADMIN" }), ctx({ id: wsA, userId: users.dev.id }))).status).toBe(403);
    expect((await Member.PATCH(req("PATCH", { role: "OWNER" }), ctx({ id: wsA, userId: users.dev.id }))).status).toBe(422);
    expect((await Member.PATCH(req("PATCH", { role: "VIEWER" }), ctx({ id: wsA, userId: users.owner.id }))).status).toBe(409);
    expect((await Invitations.POST(req("POST", { email: "boss@t.local", role: "ADMIN" }), ctx({ id: wsA }))).status).toBe(403);
    expect((await Transfer.POST(req("POST", { userId: users.admin.id }), ctx({ id: wsA }))).status).toBe(403);
    // Allowed downward change by the owner, audited.
    await signIn(users.owner);
    expect((await Member.PATCH(req("PATCH", { role: "VIEWER" }), ctx({ id: wsA, userId: users.dev.id }))).status).toBe(200);
    expect((await Member.PATCH(req("PATCH", { role: "MEMBER" }), ctx({ id: wsA, userId: users.dev.id }))).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { companyId: wsA, action: "MEMBER_ROLE_CHANGED" } })).toBe(2);
  });

  it("a developer cannot deploy to production; the plan's feature gate and the role gate both hold", async () => {
    await signIn(users.dev);
    const r = await Deploy.POST(req("POST", { action: "target", env: "production", provider: "docker-host", config: {} }), ctx({ id: wsA, productId: productA }));
    expect(r.status).toBe(403);
  });
});

describe("invitations and seats", () => {
  it("invite → accept only by the invited address, single use, seat counted; outsider tokens are useless", async () => {
    await signIn(users.admin);
    const inv = await json(await Invitations.POST(req("POST", { email: users.invitee.email, role: "MEMBER" }), ctx({ id: wsA })));
    expect(inv.status).toBe(201);
    expect(inv.body.data.emailSent).toBe(false); // email not configured — never reported as sent
    const token = new URL(inv.body.data.devLink).searchParams.get("token")!;
    // The outbox copy never holds a usable token.
    const mail = await prisma.emailMessage.findFirst({ where: { to: users.invitee.email }, orderBy: { createdAt: "desc" } });
    expect(mail!.body).not.toContain(token);
    expect(outboxCopy(`x?token=${token}`)).toBe("x?token=[redacted]");
    await signIn(users.outsider);
    expect((await AcceptInvite.POST(req("POST", { token }), none)).status).toBe(403);
    await signIn(users.invitee);
    const ok = await json(await AcceptInvite.POST(req("POST", { token }), none));
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ companyId: wsA, role: "MEMBER" });
    expect((await AcceptInvite.POST(req("POST", { token }), none)).status).toBe(409);
    expect(await prisma.auditLog.count({ where: { companyId: wsA, action: { in: ["MEMBER_INVITED", "MEMBER_JOINED"] } } })).toBe(2);
  });

  it("seat limits are enforced server-side (members + pending invitations)", async () => {
    const small = (await createCompany({ name: `V8-S-${stamp}`, mission: "m", industry: "SaaS", ownerId: users.admin.id })).id;
    await signIn(users.admin);
    // Free plan: 1 seat, used by the owner.
    const r = await json(await Invitations.POST(req("POST", { email: "someone@t.local" }), ctx({ id: small })));
    expect(r.status).toBe(402);
    expect(r.body.error).toMatch(/1 seat/);
    await prisma.company.delete({ where: { id: small } });
  });

  it("removed members lose access on their next request", async () => {
    await signIn(users.admin);
    expect((await Member.DELETE(req("DELETE"), ctx({ id: wsA, userId: users.invitee.id }))).status).toBe(200);
    await signIn(users.invitee);
    expect((await Company.GET(req(), ctx({ id: wsA }))).status).toBe(404);
  });
});

describe("billing (Stripe test double)", () => {
  it("checkout creation: monthly and annual prices, server-side, nothing granted by the redirect", async () => {
    const ws = (await createCompany({ name: `V8-Bill-${stamp}`, mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
    await signIn(users.owner);
    const m = await json(await Checkout.POST(req("POST", { plan: "pro" }), ctx({ id: ws })));
    expect(m.status).toBe(200);
    expect(m.body.data.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const y = await json(await Checkout.POST(req("POST", { plan: "pro", interval: "year" }), ctx({ id: ws })));
    expect(y.status).toBe(200);
    const sessions = stripe.calls.filter((c) => c.path === "/v1/checkout/sessions");
    expect(sessions.slice(-2).map((c) => c.body.get("line_items[0][price]"))).toEqual(["price_pro_m", "price_pro_year"]);
    expect((await json(await Checkout.POST(req("POST", { plan: "team", interval: "year" }), ctx({ id: ws })))).status).toBe(422); // annual not offered for team here
    expect((await effectivePlan(ws)).plan.id).toBe("free");
    // Webhook activates; a duplicate is ignored; a stale (older) event cannot roll state back.
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { companyId: ws } });
    await hook({ id: `evt_co_${stamp}`, type: "checkout.session.completed", created: T0 + 100, data: { object: { client_reference_id: ws, customer: sub.stripeCustomerId, subscription: `sub_${stamp}` } } });
    const active = { id: `evt_up_${stamp}`, type: "customer.subscription.updated", created: T0 + 200, data: { object: { id: `sub_${stamp}`, customer: sub.stripeCustomerId, status: "active", current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30, items: { data: [{ id: "si_1", price: { id: "price_pro_m", recurring: { interval: "month" } } }] } } } };
    expect((await hook(active)).status).toBe(200);
    expect((await json(await hook(active))).body.data.result).toBe("duplicate");
    const stale = { ...active, id: `evt_stale_${stamp}`, created: T0 + 150, data: { object: { ...active.data.object, status: "incomplete_expired" } } };
    expect((await json(await hook(stale))).body.data.result).toMatch(/stale event ignored/);
    const e = await effectivePlan(ws);
    expect(e).toMatchObject({ plan: { id: "pro" }, status: "active" });

    // Upgrade in place (prorated by the provider) — entitlements change only when the webhook confirms.
    stripe.addSubscription(`sub_${stamp}`, sub.stripeCustomerId!, "price_pro_m");
    const up = await json(await Checkout.POST(req("POST", { plan: "team" }), ctx({ id: ws })));
    expect(up.body.data).toMatchObject({ changed: true, url: null });
    const change = stripe.calls.filter((c) => c.method === "POST" && c.path === `/v1/subscriptions/sub_${stamp}`).pop()!;
    expect(change.body.get("proration_behavior")).toBe("create_prorations");
    expect(change.body.get("items[0][price]")).toBe("price_team_m");
    expect((await effectivePlan(ws)).plan.id).toBe("pro");
    // Server-side retrieval syncs the confirmed state (no browser involvement).
    expect((await json(await Sync.POST(req("POST"), ctx({ id: ws })))).body.data).toMatchObject({ synced: true, plan: "team" });
    expect((await effectivePlan(ws)).plan.id).toBe("team");

    // Failed payment → past_due (access kept) → paid invoice → active; invoices are recorded.
    await hook({ id: `evt_fail_${stamp}`, type: "invoice.payment_failed", created: T0 + 7200, data: { object: { id: `in_${stamp}`, customer: sub.stripeCustomerId, status: "open", amount_due: 19900, amount_paid: 0, currency: "usd", hosted_invoice_url: "https://invoice.stripe.test/i" } } });
    expect((await effectivePlan(ws)).status).toBe("past_due");
    expect((await effectivePlan(ws)).plan.id).toBe("team");
    await hook({ id: `evt_paid_${stamp}`, type: "invoice.paid", created: T0 + 7201, data: { object: { id: `in_${stamp}`, customer: sub.stripeCustomerId, status: "paid", amount_due: 19900, amount_paid: 19900, currency: "usd" } } });
    expect((await effectivePlan(ws)).status).toBe("active");
    const b = await json(await Billing.GET(req(), ctx({ id: ws })));
    expect(b.body.data.invoices).toEqual([expect.objectContaining({ id: `in_${stamp}`, status: "paid", amountPaid: 19900 })]);

    // Cancellation request → webhook deleted → free, entitlements drop.
    expect((await Cancel.POST(req("POST", {}), ctx({ id: ws }))).status).toBe(200);
    await hook({ id: `evt_del_${stamp}`, type: "customer.subscription.deleted", created: T0 + 7300, data: { object: { id: `sub_${stamp}`, customer: sub.stripeCustomerId, status: "canceled", items: { data: [] } } } });
    expect((await effectivePlan(ws)).plan.id).toBe("free");
    await prisma.company.delete({ where: { id: ws } });
  });

  it("a webhook whose processing fails is retried by the provider — not swallowed as a duplicate", async () => {
    // A real processing failure: the event's subscription id belongs to one workspace and its customer to another.
    // Whichever row the lookup finds, applying the event violates a unique column → processing throws.
    const blocker = (await createCompany({ name: `V8-Blk-${stamp}`, mission: "m", industry: "SaaS", ownerId: users.outsider.id })).id;
    await prisma.subscription.create({ data: { companyId: blocker, stripeSubscriptionId: `sub_held_${stamp}` } });
    await prisma.subscription.upsert({ where: { companyId: wsB }, create: { companyId: wsB, stripeCustomerId: `cus_b_${stamp}` }, update: { stripeCustomerId: `cus_b_${stamp}` } });
    const ev = { id: `evt_retry_${stamp}`, type: "customer.subscription.updated", created: T0 + 500, data: { object: { id: `sub_held_${stamp}`, customer: `cus_b_${stamp}`, status: "active", items: { data: [] } } } };
    expect((await hook(ev)).status).toBe(500);
    expect((await prisma.billingEvent.findUniqueOrThrow({ where: { id: ev.id } })).processed).toBe(false);
    // The operator repairs the data; Stripe's retry of the SAME event id is processed (not "duplicate").
    await prisma.subscription.update({ where: { companyId: blocker }, data: { stripeSubscriptionId: null } });
    const r = await json(await hook(ev));
    expect(r.status).toBe(200);
    expect(r.body.data.result).toMatch(/status active/);
    const row = await prisma.billingEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect([row.processed, row.attempts, row.companyId]).toEqual([true, 2, wsB]);
    expect((await json(await hook(ev))).body.data.result).toBe("duplicate");
    await prisma.company.delete({ where: { id: blocker } });
    await prisma.subscription.deleteMany({ where: { companyId: wsB } });
  });

  it("invalid signatures are rejected with no state change", async () => {
    const raw = JSON.stringify({ id: `evt_bad_${stamp}`, type: "customer.subscription.deleted", data: { object: { metadata: { companyId: wsA } } } });
    expect((await Webhook.POST(req("POST", raw, { "stripe-signature": "t=1,v1=00" }))).status).toBe(400);
    expect(await prisma.billingEvent.count({ where: { id: `evt_bad_${stamp}` } })).toBe(0);
  });

  it("downgrades that the current usage would violate are refused with an explanation", async () => {
    const ws = (await createCompany({ name: `V8-Down-${stamp}`, mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
    await prisma.subscription.create({ data: { companyId: ws, plan: "team", status: "active", stripeSubscriptionId: `sub_down_${stamp}`, stripeCustomerId: `cus_down_${stamp}` } });
    for (const u of [users.admin, users.dev, users.viewer]) await prisma.workspaceMember.create({ data: { userId: u.id, companyId: ws, role: "MEMBER" } });
    await signIn(users.owner);
    const r = await json(await Checkout.POST(req("POST", { plan: "pro" }), ctx({ id: ws })));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/4 seats in use \(the Pro plan allows 3\)/);
    await prisma.company.delete({ where: { id: ws } });
  });
});

describe("usage, quotas and the ledger", () => {
  it("quotas hold under concurrent requests: exactly the limit succeeds", async () => {
    const ws = (await createCompany({ name: `V8-Q-${stamp}`, mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
    const results = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => reserve(ws, "build", `qtest:${stamp}:${i}`)));
    const okN = results.filter((r) => r.status === "fulfilled").length;
    expect(okN).toBe(10); // free plan: 10 runs / month
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof QuotaError)).toBe(true);
    const c = await prisma.usageCounter.findUniqueOrThrow({ where: { companyId_metric_period: { companyId: ws, metric: "build", period: periodOf() } } });
    expect(c.reserved).toBe(10);
    await prisma.company.delete({ where: { id: ws } });
  });

  it("concurrency slots: parallel build starts never exceed the plan's concurrent runs", async () => {
    const ws = (await createCompany({ name: `V8-C-${stamp}`, mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => reserve(ws, "concurrent_build", `ctest:${stamp}:${i}`)));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    await prisma.company.delete({ where: { id: ws } });
  });

  it("failed or abandoned work releases its reservation; settled work counts once", async () => {
    const ws = (await createCompany({ name: `V8-R-${stamp}`, mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
    await reserve(ws, "build", "r:fail");
    await reserve(ws, "build", "r:ok");
    await reserve(ws, "build", "r:abandoned", 1, { ttlMs: -1000 }); // already expired: a crashed worker's hold
    expect(await settle("r:fail", "build", null)).toBe("RELEASED");
    expect(await settle("r:fail", "build", null)).toBeNull(); // idempotent
    expect(await settle("r:ok", "build", 1)).toBe("SETTLED");
    expect(await recoverReservations()).toBeGreaterThanOrEqual(1);
    const c = await prisma.usageCounter.findUniqueOrThrow({ where: { companyId_metric_period: { companyId: ws, metric: "build", period: periodOf() } } });
    expect({ used: c.used, reserved: c.reserved }).toEqual({ used: 1, reserved: 0 });
    const holds = await prisma.usageReservation.findMany({ where: { companyId: ws }, orderBy: { ref: "asc" } });
    expect(holds.map((h) => [h.ref, h.status])).toEqual([["r:abandoned", "RELEASED"], ["r:fail", "RELEASED"], ["r:ok", "SETTLED"]]);
    await prisma.company.delete({ where: { id: ws } });
  });

  it("usage records are idempotent: retries and duplicate events never double-count", async () => {
    const ws = (await createCompany({ name: `V8-L-${stamp}`, mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
    const entry = [{ metric: "ai_cost_usd", quantity: 0.42, basis: "estimated" as const, model: "claude-sonnet-x" }, { metric: "ai_tokens_in", quantity: 1000 }];
    expect(await recordUsage(ws, entry, "agent_run:dup")).toBe(2);
    expect(await recordUsage(ws, entry, "agent_run:dup")).toBe(0);
    await Promise.all([recordUsage(ws, entry, "agent_run:race"), recordUsage(ws, entry, "agent_run:race")]);
    const u = await usageThisMonth(ws);
    expect(u.aiCostUsd).toBeCloseTo(0.84, 6);
    expect(u.tokensIn).toBe(2000);
    const rows = await prisma.usageEvent.findMany({ where: { companyId: ws, metric: "ai_cost_usd" } });
    expect(rows.every((r) => r.basis === "estimated" && r.model === "claude-sonnet-x")).toBe(true);
    // Counter matches the ledger (reconciliation finds nothing to fix).
    expect(await reconcileCounters(ws)).toEqual([]);
    await prisma.company.delete({ where: { id: ws } });
  });

  it("a customer spending cap stops eligible operations before they start", async () => {
    const ws = (await createCompany({ name: `V8-Cap-${stamp}`, mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
    await prisma.subscription.create({ data: { companyId: ws, plan: "pro", status: "active" } });
    await signIn(users.owner);
    expect((await Company.PATCH(req("PATCH", { monthlyBudgetUsd: 1 }), ctx({ id: ws }))).status).toBe(200);
    await recordUsage(ws, [{ metric: "ai_cost_usd", quantity: 1.05 }], "agent_run:cap");
    const p = await createProduct({ companyId: ws, userId: users.owner.id, actor: users.owner.email, idea: "A product to test the spending cap enforcement path." });
    await expect(startBuild({ companyId: ws, productId: p.product.id, itemKey: "T1", actor: "t", maxRepairs: 0 })).rejects.toThrow(/spending cap of \$1\.00/);
    expect(await prisma.build.count({ where: { companyId: ws } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { companyId: ws, action: "SPENDING_CAP_CHANGED" } })).toBe(1);
    await prisma.company.delete({ where: { id: ws } });
  });
});

describe("authentication and sessions", () => {
  it("signup → session → verify email → login; enumeration-safe errors; weak passwords refused", async () => {
    resetRateLimits();
    jar.clear();
    const email = `v8_signup_${stamp}@t.local`;
    expect((await Register.POST(req("POST", { email, name: "New", password: "short" }), none)).status).toBe(422);
    const r = await json(await Register.POST(req("POST", { email, name: "New", password: "a-long-enough-password" }), none));
    expect(r.status).toBe(201);
    expect(r.body.data.verification).toMatchObject({ sent: false, configured: false });
    expect(jar.get(SESSION_COOKIE)).toBeTruthy();
    const me = await json(await Me.GET(req(), none));
    expect(me.body.data.user.email).toBe(email);
    const token = new URL(r.body.data.verification.devLink).searchParams.get("token")!;
    expect((await Verify.POST(req("POST", { token }), none)).status).toBe(200);
    expect((await Verify.POST(req("POST", { token }), none)).status).toBe(400); // single use
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt).not.toBeNull();
    // Wrong password and unknown account produce the identical response.
    const a = await json(await Login.POST(req("POST", { email, password: "wrong-password-123" }), none));
    const b = await json(await Login.POST(req("POST", { email: `nobody_${stamp}@t.local`, password: "wrong-password-123" }), none));
    expect([a.status, a.body.error]).toEqual([b.status, b.body.error]);
    // Password reset request: same response whether or not the account exists.
    const x = await json(await Reset.POST(req("POST", { email }), none));
    const y = await json(await Reset.POST(req("POST", { email: `nobody_${stamp}@t.local` }), none));
    expect(x.body.data.requested).toBe(y.body.data.requested);
  });

  it("logout revokes the token server-side (a copied cookie stops working)", async () => {
    await signIn(users.dev);
    const stolen = jar.get(SESSION_COOKIE)!;
    expect(await validateSessionToken(stolen)).not.toBeNull();
    await Logout.POST(req("POST", {}), none);
    expect(await validateSessionToken(stolen)).toBeNull();
    jar.set(SESSION_COOKIE, stolen);
    expect((await Company.GET(req(), ctx({ id: wsA }))).status).toBe(401);
  });

  it("password reset and password change invalidate every other session", async () => {
    resetRateLimits();
    const u = await prisma.user.create({ data: { email: `v8_pw_${stamp}@t.local`, name: "pw", passwordHash: await (await import("@/lib/auth/password")).hashPassword("original-password-1") } });
    created.push(u.id);
    await signIn(u);
    const laptop = jar.get(SESSION_COOKIE)!;
    const reset = await json(await Reset.POST(req("POST", { email: u.email }), none));
    const token = new URL(reset.body.data.devLink).searchParams.get("token")!;
    expect((await Reset.POST(req("POST", { token, password: "brand-new-password-2" }), none)).status).toBe(200);
    expect(await validateSessionToken(laptop)).toBeNull();
    // Change password while signed in: this browser gets a fresh session; the others die.
    jar.clear();
    expect((await Login.POST(req("POST", { email: u.email, password: "brand-new-password-2" }), none)).status).toBe(200);
    const phone = jar.get(SESSION_COOKIE)!;
    await signIn(u);
    expect((await Password.POST(req("POST", { current: "brand-new-password-2", next: "third-password-3x" }), none)).status).toBe(200);
    expect(await validateSessionToken(phone)).toBeNull();
    expect(await validateSessionToken(jar.get(SESSION_COOKIE)!)).not.toBeNull();
  });

  it("login is rate limited per account", async () => {
    resetRateLimits();
    const email = users.viewer.email;
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await Login.POST(req("POST", { email, password: "nope-nope-nope" }), none)).status);
    expect(codes.slice(0, 8).every((c) => c === 401)).toBe(true);
    expect(codes.slice(8)).toEqual([429, 429]);
    resetRateLimits();
  });

  it("CSRF: cross-site state-changing requests are blocked; same-origin and webhooks are not", () => {
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
    expect(csrfViolation("POST", "/api/companies/x/products", h({ origin: "https://evil.example" }), "https://app.aura.test")).toMatch(/cross-origin/);
    expect(csrfViolation("POST", "/api/companies/x/products", h({ origin: "https://app.aura.test" }), "https://app.aura.test")).toBeNull();
    expect(csrfViolation("DELETE", "/api/auth/account", h({ referer: "https://evil.example/page" }), "https://app.aura.test")).toMatch(/cross-origin/);
    expect(csrfViolation("GET", "/api/companies/x", h({ origin: "https://evil.example" }), "https://app.aura.test")).toBeNull();
    expect(csrfViolation("POST", "/api/billing/webhook", h({ origin: "https://stripe.example" }), "https://app.aura.test")).toBeNull();
  });

  it("platform admin surface is invisible to tenants (404) and audited for operators", async () => {
    await signIn(users.owner);
    expect((await Admin.GET(req(), none)).status).toBe(404);
    await prisma.user.update({ where: { id: users.admin.id }, data: { isPlatformAdmin: true } });
    await signIn(users.admin);
    const r = await json(await Admin.GET(req(), none));
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/@t\.local/); // aggregates only, no customer identities
    expect(await prisma.platformAudit.count({ where: { actor: users.admin.email } })).toBeGreaterThan(0);
    await prisma.user.update({ where: { id: users.admin.id }, data: { isPlatformAdmin: false } });
  });
});

describe("secrets and redaction", () => {
  it("secrets are encrypted at rest, bound to the tenant, write-only through the API", async () => {
    await signIn(users.admin);
    expect((await Secrets.PUT(req("PUT", { name: "PAYMENTS_API_KEY", value: "pk_live_supersecretvalue123" }), ctx({ id: wsA }))).status).toBe(200);
    expect((await Secrets.PUT(req("PUT", { name: "ANTHROPIC_API_KEY", value: "x" }), ctx({ id: wsA }))).status).toBe(422); // reserved
    const row = await prisma.workspaceSecret.findUniqueOrThrow({ where: { companyId_name: { companyId: wsA, name: "PAYMENTS_API_KEY" } } });
    expect(row.ciphertext).not.toContain("supersecret");
    expect(decrypt(wsA, row)).toBe("pk_live_supersecretvalue123");
    expect(() => decrypt(wsB, row)).toThrow(); // copied into another tenant: authentication fails
    const listed = JSON.stringify((await json(await Secrets.GET(req(), ctx({ id: wsA })))).body);
    expect(listed).toContain("PAYMENTS_API_KEY");
    expect(listed).not.toContain("supersecret");
    expect(JSON.stringify(await prisma.auditLog.findMany({ where: { companyId: wsA, category: "secret" } }))).not.toContain("supersecret");
    const enc = encrypt(wsA, "v");
    expect(enc.iv).not.toBe(encrypt(wsA, "v").iv);
  });

  it("deployment secrets come only from the tenant's store — never the AURA server environment", async () => {
    process.env.SOME_SERVER_TOKEN = "server-only-token-value-xyz";
    await signIn(users.admin);
    const r = await json(await Deploy.POST(req("POST", { action: "target", env: "preview", provider: "docker-host", config: {}, secretEnvNames: ["SOME_SERVER_TOKEN", "PAYMENTS_API_KEY"] }), ctx({ id: wsA, productId: productA })));
    expect(r.status).toBe(200);
    const targets = await json(await Deploy.GET(req(), ctx({ id: wsA, productId: productA })));
    const t = targets.body.data.targets?.find?.((x: { env: string }) => x.env === "preview") ?? targets.body.data.find?.((x: { env: string }) => x.env === "preview");
    expect(t.secretsPresent).toEqual({ SOME_SERVER_TOKEN: false, PAYMENTS_API_KEY: true });
    delete process.env.SOME_SERVER_TOKEN;
  });

  it("redaction scrubs credential shapes and known secret values", () => {
    const s = redactText("key sk-ant-api03-abcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwxyz1234 Authorization: Bearer abc.def STRIPE_SECRET_KEY=sk_live_1234567890 https://user:pw@host/x -----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----");
    expect(s).not.toMatch(/sk-ant-api03|ghp_abc|Bearer abc|sk_live_1234|user:pw|MIIE/);
  });
});

describe("customer lifecycle", () => {
  it("project archival frees a slot, is read-only, and restores", async () => {
    await signIn(users.dev);
    expect((await Archive.POST(req("POST", { action: "archive" }), ctx({ id: wsA, productId: productA }))).status).toBe(403);
    await signIn(users.admin);
    expect((await json(await Archive.POST(req("POST", { action: "archive" }), ctx({ id: wsA, productId: productA })))).body.data.status).toBe("ARCHIVED");
    const d = await json(await Deploy.POST(req("POST", { action: "deploy", env: "preview" }), ctx({ id: wsA, productId: productA })));
    expect(d.status).toBe(409);
    expect(d.body.error).toMatch(/archived/);
    expect((await json(await Archive.POST(req("POST", { action: "restore" }), ctx({ id: wsA, productId: productA })))).body.data.status).toBe("PAUSED");
  });

  it("integration disconnection revokes AURA's use of the installation and is audited", async () => {
    const i = await prisma.githubInstallation.create({ data: { companyId: wsA, installationId: 4242, account: "acme", connectedBy: users.owner.email } });
    await signIn(users.dev);
    expect((await GithubDisconnect.DELETE(req("DELETE"), ctx({ id: wsA, installId: i.id }))).status).toBe(403);
    await signIn(users.outsider);
    expect((await GithubDisconnect.DELETE(req("DELETE"), ctx({ id: wsB, installId: i.id }))).status).toBe(404); // another tenant's id
    await signIn(users.admin);
    expect((await GithubDisconnect.DELETE(req("DELETE"), ctx({ id: wsA, installId: i.id }))).status).toBe(200);
    expect((await prisma.githubInstallation.findUniqueOrThrow({ where: { id: i.id } })).status).toBe("REVOKED");
    expect(await prisma.auditLog.count({ where: { companyId: wsA, action: "GITHUB_DISCONNECTED", category: "integration" } })).toBe(1);
  });

  it("data export contains the tenant's records and no secret values or credentials", async () => {
    await signIn(users.admin);
    const r = await Export.GET(req(), ctx({ id: wsA }));
    expect(r.status).toBe(200);
    const text = await r.text();
    const data = JSON.parse(text);
    expect(data.format).toBe("aura-workspace-export/1");
    expect(data.products.map((p: { id: string }) => p.id)).toContain(productA);
    expect(data.secrets.map((s: { name: string }) => s.name)).toContain("PAYMENTS_API_KEY");
    expect(text).not.toMatch(/supersecret|passwordHash|tokenHash|ciphertext/);
    expect(text).not.toContain(wsB);
    expect(await prisma.auditLog.count({ where: { companyId: wsA, action: "DATA_EXPORTED" } })).toBe(1);
  });

  it("audit log is readable by admins only and lists security, membership, billing and data events", async () => {
    await signIn(users.dev);
    expect((await AuditLog.GET(req(), ctx({ id: wsA }))).status).toBe(403);
    await signIn(users.admin);
    const r = await json(await AuditLog.GET(req(), ctx({ id: wsA })));
    const cats = new Set(r.body.data.entries.map((e: { category: string }) => e.category));
    for (const c of ["security", "membership", "secret", "data", "integration"]) expect(cats.has(c)).toBe(true);
  });

  it("workspace deletion: owner only, refused while a paid plan renews, then removes the tenant's data", async () => {
    const ws = (await createCompany({ name: `V8-Del-${stamp}`, mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
    await prisma.subscription.create({ data: { companyId: ws, plan: "pro", status: "active" } });
    await prisma.usageEvent.create({ data: { companyId: ws, metric: "build", quantity: 1, source: "x" } });
    await signIn(users.owner);
    expect((await Company.DELETE(req("DELETE", { confirm: `V8-Del-${stamp}` }), ctx({ id: ws }))).status).toBe(409);
    await prisma.subscription.update({ where: { companyId: ws }, data: { cancelAtPeriodEnd: true } });
    expect((await Company.DELETE(req("DELETE", { confirm: "wrong name" }), ctx({ id: ws }))).status).toBe(422);
    const d = await json(await Company.DELETE(req("DELETE", { confirm: `V8-Del-${stamp}` }), ctx({ id: ws })));
    expect(d.status).toBe(200);
    expect(d.body.data.retainedElsewhere.length).toBeGreaterThan(0); // honest about what is NOT deleted
    expect(await prisma.company.count({ where: { id: ws } })).toBe(0);
    expect(await prisma.usageEvent.count({ where: { companyId: ws } })).toBe(0);
  });

  it("account deletion refuses while the user owns a shared workspace, then deletes", async () => {
    const u = await prisma.user.create({ data: { email: `v8_del_${stamp}@t.local`, name: "d", passwordHash: await (await import("@/lib/auth/password")).hashPassword("delete-me-password") } });
    created.push(u.id);
    const ws = (await createCompany({ name: `V8-Acc-${stamp}`, mission: "m", industry: "SaaS", ownerId: u.id })).id;
    await prisma.workspaceMember.create({ data: { userId: users.dev.id, companyId: ws, role: "MEMBER" } });
    await signIn(u);
    const r = await json(await Account.DELETE(req("DELETE", { password: "delete-me-password" }), none));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Transfer ownership/);
    await prisma.workspaceMember.deleteMany({ where: { companyId: ws, userId: users.dev.id } });
    expect((await Account.DELETE(req("DELETE", { password: "delete-me-password" }), none)).status).toBe(200);
    expect(await prisma.user.count({ where: { id: u.id } })).toBe(0);
    expect(await prisma.company.count({ where: { id: ws } })).toBe(0);
  });
});

describe("operations", () => {
  it("production config validation refuses test-double overrides and a Stripe key without a webhook secret", async () => {
    const { validateRuntimeConfig } = await import("@/lib/runtime/config");
    const v = validateRuntimeConfig({ NODE_ENV: "production", DATABASE_URL: "file:x", AUTH_SECRET: "x".repeat(32), STRIPE_SECRET_KEY: "sk_live_x", STRIPE_API_BASE: "http://127.0.0.1:1", AURA_SECRETS_KEY: "short" } as unknown as NodeJS.ProcessEnv);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/STRIPE_API_BASE/);
    expect(v.errors.join(" ")).toMatch(/STRIPE_WEBHOOK_SECRET/);
    expect(v.errors.join(" ")).toMatch(/AURA_SECRETS_KEY/);
  });

  it("quota warnings and abnormal-spend alerts are raised from the ledger", async () => {
    const { commercialAlerts } = await import("@/lib/runtime/observe");
    const ws = (await createCompany({ name: `V8-Alert-${stamp}`, mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
    await recordUsage(ws, [{ metric: "ai_cost_usd", quantity: 2.5 }], "agent_run:spike"); // free plan: $3 budget
    const alerts = await commercialAlerts(ws);
    expect(alerts.map((a) => a.key)).toEqual(expect.arrayContaining(["quota:ai", "cost-spike"]));
    await prisma.company.delete({ where: { id: ws } });
  });

  it("the dev session secret can never verify tokens in production at the edge", async () => {
    const { verifySessionTokenEdge } = await import("@/lib/auth/edge");
    const tok = await createSessionToken({ userId: users.owner.id, email: users.owner.email });
    const env = process.env as Record<string, string | undefined>;
    const prev = { NODE_ENV: env.NODE_ENV, AUTH_SECRET: env.AUTH_SECRET };
    env.NODE_ENV = "production";
    delete env.AUTH_SECRET;
    expect(await verifySessionTokenEdge(tok)).toBeNull();
    env.NODE_ENV = prev.NODE_ENV;
    if (prev.AUTH_SECRET) env.AUTH_SECRET = prev.AUTH_SECRET;
  });
});

describe("artifact downloads (screenshots) enforce tenant scope", () => {
  it("another tenant cannot fetch a run's screenshot; a path outside the evidence root is refused", async () => {
    const Run = await import("@/app/api/companies/[id]/builds/[buildId]/route");
    const b = await prisma.build.create({ data: { companyId: wsA, productId: productA, itemKey: "X1", branch: "aura/x1", correlationId: "c", createdBy: "t", browser: JSON.stringify({ status: "passed", routes: [{ route: "/", viewport: "desktop", screenshot: "/etc/passwd" }] }) } });
    await signIn(users.outsider);
    expect((await Run.GET(new Request("http://t.local/x?screenshot=0"), ctx({ id: wsA, buildId: b.id }))).status).toBe(404);
    expect((await Run.GET(new Request("http://t.local/x?screenshot=0"), ctx({ id: wsB, buildId: b.id }))).status).toBe(404);
    await signIn(users.viewer);
    expect((await Run.GET(new Request("http://t.local/x?screenshot=0"), ctx({ id: wsA, buildId: b.id }))).status).toBe(404); // outside evidence root: never served
    const detail = await json(await Run.GET(new Request("http://t.local/x"), ctx({ id: wsA, buildId: b.id })));
    expect(JSON.stringify(detail.body)).not.toContain("/etc/passwd");
    await prisma.build.delete({ where: { id: b.id } });
  });
});

describe("engineering intelligence routes (V11): authorization and isolation", () => {
  it("other tenants get 404; viewers read; only members record feedback; only admins optimize", async () => {
    const Learning = await import("@/app/api/companies/[id]/learning/route");
    const Feedback = await import("@/app/api/companies/[id]/learning/feedback/route");
    const FeedbackItem = await import("@/app/api/companies/[id]/learning/feedback/[feedbackId]/route");
    const Optimize = await import("@/app/api/companies/[id]/learning/optimize/route");
    const RunL = await import("@/app/api/companies/[id]/learning/runs/[buildId]/route");
    await signIn(users.outsider);
    expect((await Learning.GET(req(), ctx({ id: wsA }))).status).toBe(404);
    expect((await Feedback.POST(req("POST", { text: "mobile is broken" }), ctx({ id: wsA }))).status).toBe(404);
    await signIn(users.viewer);
    expect((await Learning.GET(req(), ctx({ id: wsA }))).status).toBe(200);
    expect((await Feedback.POST(req("POST", { text: "mobile is broken", productId: productA }), ctx({ id: wsA }))).status).toBe(403);
    await signIn(users.dev);
    const fb = await json(await Feedback.POST(req("POST", { text: "The mobile layout is broken", productId: productA }), ctx({ id: wsA })));
    expect(fb.status).toBe(201);
    expect(fb.body.data.kind).toBe("responsive");
    expect((await Feedback.POST(req("POST", { text: "x is wrong", productId: "not-mine" }), ctx({ id: wsA }))).status).toBe(404);
    expect((await Optimize.POST(req("POST", { action: "propose", agentKey: "backend-engineer", category: "code_generation" }), ctx({ id: wsA }))).status).toBe(403);
    // Feedback of tenant A cannot be changed through tenant B.
    await signIn(users.outsider);
    expect((await FeedbackItem.DELETE(req("DELETE"), ctx({ id: wsB, feedbackId: fb.body.data.id }))).status).toBe(404);
    const foreignBuild = await prisma.build.create({ data: { companyId: wsA, productId: productA, itemKey: "L1", branch: "aura/l1", correlationId: "c", createdBy: "t" } });
    expect((await RunL.GET(req(), ctx({ id: wsB, buildId: foreignBuild.id }))).status).toBe(404);
    await signIn(users.dev);
    const ov = await json(await Learning.GET(req(), ctx({ id: wsA })));
    expect(ov.body.data.feedback.map((f: { id: string }) => f.id)).toContain(fb.body.data.id);
    expect(JSON.stringify(ov.body.data)).not.toContain(wsB);
    expect((await FeedbackItem.PATCH(req("PATCH", { status: "DISABLED" }), ctx({ id: wsA, feedbackId: fb.body.data.id }))).status).toBe(200);
    expect((await FeedbackItem.DELETE(req("DELETE"), ctx({ id: wsA, feedbackId: fb.body.data.id }))).status).toBe(200);
    await prisma.build.delete({ where: { id: foreignBuild.id } });
  });

  it("delivery does not depend on the learning subsystem: emit and retrieval failures are swallowed", async () => {
    const { emit } = await import("@/lib/learning/service");
    const { learningContext } = await import("@/lib/learning/retrieval");
    const spy = vi.spyOn(prisma.learningEvent, "create").mockRejectedValueOnce(new Error("learning store down"));
    expect(await emit({ companyId: wsA, type: "build.started", key: `k-${stamp}` })).toBe(false);
    spy.mockRestore();
    const spy2 = vi.spyOn(prisma.failureAttribution, "findMany").mockRejectedValueOnce(new Error("down"));
    const ctxL = await learningContext({ companyId: wsA, productId: productA, buildId: "x", itemKey: "T", kind: "BACKEND", stack: "node-web", title: "t", description: "", acceptance: [], files: [], requirements: [], signatures: [], currentFiles: [], failureCategories: [] });
    spy2.mockRestore();
    expect(ctxL).toMatchObject({ text: "", manifest: [], criteria: [] });
  });
});
