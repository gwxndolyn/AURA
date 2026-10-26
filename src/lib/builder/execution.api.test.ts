/**
 * Adaptive execution API boundary (real handlers + real authz): viewers read,
 * only admins change/roll back the policy, invalid policy is rejected, another
 * workspace gets 404, changes are audited. Plus model-routing configuration:
 * an unavailable model falls back only within the approved provider set.
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
import { createProduct } from "@/lib/factory/store";
import { configuredModels, MODELS } from "@/lib/ai/claude";
import * as Execution from "@/app/api/companies/[id]/products/[productId]/execution/route";
import { routeModel, DEFAULT_MODEL_POLICY } from "./adaptive";

const users: Record<string, { id: string; email: string }> = {};
let wsA = "", wsB = "", productId = "";
const gitRoot = mkdtempSync(join(tmpdir(), "aura-git-exec-"));
const ctx = (p: Record<string, string>) => ({ params: Promise.resolve(p) as never });
const req = (method = "GET", body?: unknown) => new Request("http://t.local/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
async function as(n: string | null) {
  currentToken = n ? await createSessionToken({ userId: users[n].id, email: users[n].email }) : null;
}
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as { data?: any; error?: string } });

beforeAll(async () => {
  process.env.AURA_GIT_ROOT = gitRoot;
  const s = Date.now();
  for (const n of ["owner", "member", "viewer", "outsider"]) users[n] = await prisma.user.create({ data: { email: `${n}_${s}@exec.local`, name: n } });
  wsA = (await createCompany({ name: "EXEC-A", mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
  wsB = (await createCompany({ name: "EXEC-B", mission: "m", industry: "SaaS", ownerId: users.outsider.id })).id;
  await prisma.workspaceMember.createMany({ data: [{ userId: users.member.id, companyId: wsA, role: "MEMBER" }, { userId: users.viewer.id, companyId: wsA, role: "VIEWER" }] });
  productId = (await createProduct({ companyId: wsA, userId: users.owner.id, actor: "owner@test", idea: "Build a tiny notes API with a version endpoint for the adaptive API test." })).product.id;
}, 60_000);

afterAll(async () => {
  await prisma.job.deleteMany({ where: { companyId: { in: [wsA, wsB] } } });
  await prisma.company.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
  rmSync(gitRoot, { recursive: true, force: true });
});

describe("execution policy API", () => {
  it("viewers read; members cannot change; admins change and roll back; audited", async () => {
    await as(null);
    expect((await Execution.GET(req(), ctx({ id: wsA, productId }))).status).toBe(401);
    await as("viewer");
    const g = await json(await Execution.GET(req(), ctx({ id: wsA, productId })));
    expect(g.status).toBe(200);
    expect(g.body.data.effective).toBe("adaptive-v1");
    expect(g.body.data.policies.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(["baseline", "adaptive-v1"]));
    expect(g.body.data.runs).toEqual([]);
    await as("member");
    expect((await Execution.PATCH(req("PATCH", { adaptivePolicy: "baseline" }), ctx({ id: wsA, productId }))).status).toBe(403);
    await as("owner");
    const p = await json(await Execution.PATCH(req("PATCH", { adaptivePolicy: "baseline", mandatoryChecks: ["security_review"], allowedProviders: ["anthropic"] }), ctx({ id: wsA, productId })));
    expect(p.status).toBe(200);
    expect(p.body.data.policy).toEqual({ adaptivePolicy: "baseline", mandatoryChecks: ["security_review"], allowedProviders: ["anthropic"] });
    expect((await json(await Execution.GET(req(), ctx({ id: wsA, productId })))).body.data.effective).toBe("baseline");
    // Rollback to the default: clearing the field restores the default policy; other settings stay.
    const r = await json(await Execution.PATCH(req("PATCH", { adaptivePolicy: "" }), ctx({ id: wsA, productId })));
    expect(r.body.data.policy).toEqual({ mandatoryChecks: ["security_review"], allowedProviders: ["anthropic"] });
    expect((await json(await Execution.GET(req(), ctx({ id: wsA, productId })))).body.data.effective).toBe("adaptive-v1");
    const audits = await prisma.auditLog.findMany({ where: { companyId: wsA, action: "PRODUCT_EXECUTION_POLICY" } });
    expect(audits.length).toBe(2);
  });

  it("rejects unknown policies, strategies, checks and fields", async () => {
    await as("owner");
    for (const body of [{ adaptivePolicy: "adaptive-v99" }, { pinnedStrategy: "yolo" }, { mandatoryChecks: ["vibes"] }, { fallback: "maybe" }, { costLimit: 5 }]) {
      expect((await Execution.PATCH(req("PATCH", body), ctx({ id: wsA, productId }))).status).toBe(422);
    }
  });

  it("another workspace's product is 404 for read and write (no existence leak)", async () => {
    await as("outsider");
    expect((await Execution.GET(req(), ctx({ id: wsA, productId }))).status).toBe(404);
    expect((await Execution.GET(req(), ctx({ id: wsB, productId }))).status).toBe(404);
    expect((await Execution.PATCH(req("PATCH", { adaptivePolicy: "baseline" }), ctx({ id: wsB, productId }))).status).toBe(404);
    expect(JSON.parse((await prisma.product.findUnique({ where: { id: productId } }))!.executionPolicy).adaptivePolicy).toBeUndefined();
  });
});

describe("model routing against the configured models", () => {
  it("an unavailable model falls back to a stronger approved one; a disallowed provider is never used", () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, down: process.env.AURA_MODEL_UNAVAILABLE };
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.AURA_MODEL_UNAVAILABLE = MODELS.STANDARD;
    try {
      const r = routeModel({ tier: "STANDARD", needsTools: true, contextTokens: 30_000 }, configuredModels(), { ...DEFAULT_MODEL_POLICY, allowedProviders: ["anthropic"] });
      expect(r.chosen!.model).toBe(MODELS.REASONING);
      expect(r.fallbackUsed).toBe(true);
      const denied = routeModel({ tier: "STANDARD", needsTools: true, contextTokens: 30_000 }, configuredModels(), { ...DEFAULT_MODEL_POLICY, allowedProviders: ["openai"] });
      expect(denied.chosen).toBeNull();
      expect(denied.blocker).toBe("no compatible provider");
      const pinned = routeModel({ tier: "STANDARD", needsTools: true, contextTokens: 30_000 }, configuredModels(), { allowedProviders: [], pinnedModels: [MODELS.STANDARD], fallback: "fail" });
      expect(pinned.blocker).toBe("preferred model unavailable");
    } finally {
      process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      process.env.AURA_MODEL_UNAVAILABLE = saved.down;
      if (saved.down === undefined) delete process.env.AURA_MODEL_UNAVAILABLE;
    }
  });
});
