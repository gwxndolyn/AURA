/**
 * Product factory API boundary tests (real handlers + real authz):
 * auth, RBAC per action class, validation, IDOR, and the webhook receiver.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let currentToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "aura_session" && currentToken ? { value: currentToken } : undefined), set: () => {} }),
}));

import { prisma } from "@/lib/db";
import { createSessionToken } from "@/lib/auth/session";
import { createCompany } from "@/lib/company/provision";
import * as Products from "@/app/api/companies/[id]/products/route";
import * as Product from "@/app/api/companies/[id]/products/[productId]/route";
import * as Item from "@/app/api/companies/[id]/products/[productId]/items/[key]/route";
import * as Approval from "@/app/api/companies/[id]/products/[productId]/approvals/[approvalId]/route";
import * as Release from "@/app/api/companies/[id]/products/[productId]/release/route";
import * as Repo from "@/app/api/companies/[id]/products/[productId]/repo/route";
import * as Tick from "@/app/api/companies/[id]/products/[productId]/tick/route";
import * as Webhook from "@/app/api/webhooks/[provider]/route";
import { resetClientForTests } from "@/lib/ai/claude";
import { drain } from "@/lib/jobs/worker";
import { startAnthropicDouble, text, type Double } from "../../../test/doubles/anthropic";
import { templateBrief, templateBacklog } from "../../../test/fixtures/product";

const users: Record<string, { id: string; email: string }> = {};
let wsA: string, wsB: string, productId: string;
const gitRoot = mkdtempSync(join(tmpdir(), "aura-git-api-"));
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const req = (method = "GET", body?: unknown, url = "http://t.local/x", headers: Record<string, string> = {}) => new Request(url, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
async function as(n: string | null) {
  currentToken = n ? await createSessionToken({ userId: users[n].id, email: users[n].email }) : null;
}
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as { data?: any; error?: string } });
const IDEA = "Build a web application that helps university students find teammates based on skills and availability.";

let double: Double;
beforeAll(async () => {
  process.env.AURA_GIT_ROOT = gitRoot;
  double = await startAnthropicDouble((req) => [text(JSON.stringify(/backlog/i.test(req.system) ? templateBacklog(templateBrief(IDEA)) : templateBrief(IDEA)))]);
  process.env.ANTHROPIC_API_KEY = "test-key-for-double";
  process.env.ANTHROPIC_BASE_URL = double.url;
  resetClientForTests();
  const s = Date.now();
  for (const n of ["owner", "member", "viewer", "outsider"]) users[n] = await prisma.user.create({ data: { email: `${n}_${s}@pfapi.local`, name: n } });
  wsA = (await createCompany({ name: "PFAPI-A", mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
  wsB = (await createCompany({ name: "PFAPI-B", mission: "m", industry: "SaaS", ownerId: users.outsider.id })).id;
  await prisma.workspaceMember.createMany({ data: [{ userId: users.member.id, companyId: wsA, role: "MEMBER" }, { userId: users.viewer.id, companyId: wsA, role: "VIEWER" }] });
}, 60_000);

afterAll(async () => {
  await double.close();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  resetClientForTests();
  await prisma.company.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
  await prisma.$disconnect();
  rmSync(gitRoot, { recursive: true, force: true });
});

describe("product API", () => {
  it("auth + RBAC: viewers read, members create, admins change autonomy", async () => {
    await as(null);
    expect((await Products.GET(req(), ctx({ id: wsA }))).status).toBe(401);
    await as("viewer");
    expect((await Products.POST(req("POST", { idea: IDEA }), ctx({ id: wsA }))).status).toBe(403);
    await as("member");
    expect((await json(await Products.POST(req("POST", { idea: "too short" }), ctx({ id: wsA })))).status).toBe(422);
    const c = await json(await Products.POST(req("POST", { idea: IDEA }), ctx({ id: wsA })));
    expect(c.status).toBe(201);
    productId = c.body.data.id;
    expect(c.body.data.planningStatus).toBe("QUEUED");
    await drain(5, [wsA, wsB]);
    const d = await json(await Product.GET(req(), ctx({ id: wsA, productId })));
    expect(d.body.data.brief.source).toBe("model");
    expect((await Product.PATCH(req("PATCH", { expectedVersion: 1, autonomy: "CONTINUOUS" }), ctx({ id: wsA, productId }))).status).toBe(403);
    await as("owner");
    const s = await json(await Product.PATCH(req("PATCH", { expectedVersion: 1, autonomy: "BOUNDED" }), ctx({ id: wsA, productId })));
    expect(s.body.data).toMatchObject({ autonomy: "BOUNDED", version: 2 });
    expect((await Product.PATCH(req("PATCH", { expectedVersion: 1, autonomy: "SUGGEST" }), ctx({ id: wsA, productId }))).status).toBe(409); // stale
  }, 60_000);

  it("status edges are enforced server-side: VERIFIED cannot be set by a person", async () => {
    await as("member");
    const r = await json(await Item.PATCH(req("PATCH", { status: "VERIFIED" }), ctx({ id: wsA, productId, key: "E1.S1.T3" })));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/verification evidence|Cannot move/);
    const dn = await json(await Item.PATCH(req("PATCH", { status: "DONE_UNVERIFIED" }), ctx({ id: wsA, productId, key: "E1.S1.T3" })));
    expect(dn.status).toBe(409);
    expect(dn.body.error).toMatch(/executable test suite/);
  });

  it("publication/production need ADMIN; deploy without an approved release is refused", async () => {
    await as("member");
    expect((await Release.POST(req("POST", { action: "deploy" }), ctx({ id: wsA, productId }))).status).toBe(403);
    await as("owner");
    expect((await json(await Release.POST(req("POST", { action: "deploy" }), ctx({ id: wsA, productId })))).status).toBe(402); // free plan: not entitled
    await prisma.subscription.upsert({ where: { companyId: wsA }, create: { companyId: wsA, plan: "pro", status: "active" }, update: { plan: "pro", status: "active" } });
    expect((await json(await Release.POST(req("POST", { action: "deploy" }), ctx({ id: wsA, productId })))).status).toBe(409);
    expect((await json(await Release.POST(req("POST", { action: "candidate" }), ctx({ id: wsA, productId })))).status).toBe(409); // nothing verified yet
    const rd = await json(await Release.GET(req(), ctx({ id: wsA, productId })));
    expect(rd.body.data.productionReady).toBe(false);
  });

  it("repository connection stores env var NAMES only; tokens are refused", async () => {
    await as("owner");
    const bad = await json(await Repo.PUT(req("PUT", { provider: "github", name: "acme/app", remoteUrl: "https://github.com/acme/app.git", credentialEnv: "ghp_abcdef123" }), ctx({ id: wsA, productId })));
    expect(bad.status).toBe(422);
    const good = await json(await Repo.PUT(req("PUT", { provider: "github", name: "acme/app", remoteUrl: "https://github.com/acme/app.git", credentialEnv: "AURA_UNSET_TOKEN" }), ctx({ id: wsA, productId })));
    expect(good.status).toBe(200);
    expect(good.body.data.status.configured).toBe(false);
    expect(good.body.data.status.missing.join()).toMatch(/AURA_UNSET_TOKEN is not set/);
    const g = await json(await Repo.GET(req(), ctx({ id: wsA, productId })));
    expect(JSON.stringify(g.body)).not.toMatch(/ghp_/);
  });

  it("approvals: scope approval by a member works; cross-workspace access is 404", async () => {
    await as("member");
    const d = await json(await Product.GET(req(), ctx({ id: wsA, productId })));
    const scope = d.body.data.approvals.find((a: { action: string }) => a.action === "scope");
    expect((await json(await Approval.POST(req("POST", { decision: "approve" }), ctx({ id: wsA, productId, approvalId: scope.id })))).status).toBe(200);
    expect((await json(await Approval.POST(req("POST", { decision: "approve" }), ctx({ id: wsA, productId, approvalId: scope.id })))).status).toBe(409); // already decided
    await as("outsider");
    expect((await Product.GET(req(), ctx({ id: wsA, productId }))).status).toBe(404);
    expect((await Product.GET(req(), ctx({ id: wsB, productId }))).status).toBe(404);
    expect((await Tick.POST(req("POST", {}), ctx({ id: wsB, productId }))).status).toBe(404);
    expect((await Approval.POST(req("POST", { decision: "approve" }), ctx({ id: wsB, productId, approvalId: scope.id }))).status).toBe(404);
  });

  it("webhook receiver: unknown provider 404, unsigned 401, never needs a session", async () => {
    await as(null);
    expect((await Webhook.POST(req("POST", "{}"), ctx({ provider: "bitbucket" }))).status).toBe(404);
    const r = await Webhook.POST(req("POST", JSON.stringify({ repository: { full_name: "acme/app" } }), "http://t.local/x", { "x-github-delivery": `x-${Date.now()}`, "x-github-event": "push", "x-hub-signature-256": "sha256=00" }), ctx({ provider: "github" }));
    expect(r.status).toBe(401);
  });
});
