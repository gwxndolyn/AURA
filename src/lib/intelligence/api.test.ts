/**
 * API-boundary tests for the intelligence routes. These invoke the REAL route
 * handlers (handler() wrapper → requireWorkspaceAccess → Prisma). The only
 * stub is `next/headers` cookies(), which is fed a REAL HMAC-signed session
 * token from createSessionToken — so authentication and authorization run for
 * real. Verifies RBAC, IDOR (resource-id swapping), validation, and that
 * unauthorized production changes are rejected.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

let currentToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "aura_session" && currentToken ? { value: currentToken } : undefined),
    set: () => {},
  }),
}));

import { prisma } from "@/lib/db";
import { createSessionToken } from "@/lib/auth/session";
import * as Evaluations from "@/app/api/companies/[id]/intelligence/evaluations/route";
import * as EvaluationOne from "@/app/api/companies/[id]/intelligence/evaluations/[evaluationId]/route";
import * as Prompts from "@/app/api/companies/[id]/intelligence/prompts/route";
import * as VersionOne from "@/app/api/companies/[id]/intelligence/prompts/versions/[versionId]/route";
import * as Promote from "@/app/api/companies/[id]/intelligence/promote/route";
import * as Rollback from "@/app/api/companies/[id]/intelligence/rollback/route";
import * as Models from "@/app/api/companies/[id]/intelligence/models/route";
import * as Overview from "@/app/api/companies/[id]/intelligence/overview/route";
import * as Knowledge from "@/app/api/companies/[id]/intelligence/knowledge/[entryId]/route";
import { agentPromptKey } from "./registry";

const users: Record<string, { id: string; email: string }> = {};
let wsA: string, wsB: string;

async function as(role: keyof typeof users) {
  currentToken = await createSessionToken({ userId: users[role].id, email: users[role].email });
}
function req(method: string, body?: unknown) {
  return new Request("http://test.local/x", { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: any; error?: string } };
}

beforeAll(async () => {
  const stamp = Date.now();
  for (const r of ["owner", "admin", "member", "viewer", "outsider"]) {
    const u = await prisma.user.create({ data: { email: `${r}_${stamp}@api.local`, name: r } });
    users[r] = { id: u.id, email: u.email };
  }
  const a = await prisma.company.create({ data: { name: "API-A", mission: "m", industry: "SaaS", ownerId: users.owner.id } });
  const b = await prisma.company.create({ data: { name: "API-B", mission: "m", industry: "SaaS", ownerId: users.outsider.id } });
  wsA = a.id;
  wsB = b.id;
  await prisma.workspaceMember.createMany({
    data: [
      { userId: users.owner.id, companyId: wsA, role: "OWNER" },
      { userId: users.admin.id, companyId: wsA, role: "ADMIN" },
      { userId: users.member.id, companyId: wsA, role: "MEMBER" },
      { userId: users.viewer.id, companyId: wsA, role: "VIEWER" },
      { userId: users.outsider.id, companyId: wsB, role: "OWNER" },
    ],
  });
});

afterAll(async () => {
  currentToken = null;
  await prisma.company.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
  await prisma.$disconnect();
});

describe("authentication", () => {
  it("rejects unauthenticated requests with 401", async () => {
    currentToken = null;
    const r = await json(await Overview.GET(req("GET"), ctx({ id: wsA })));
    expect(r.status).toBe(401);
  });
  it("rejects a tampered session token", async () => {
    await as("owner");
    currentToken = currentToken!.slice(0, -2) + "xx";
    expect((await Overview.GET(req("GET"), ctx({ id: wsA }))).status).toBe(401);
  });
});

describe("workspace isolation (IDOR)", () => {
  it("an outsider gets 404 (not 403) for another workspace's intelligence data", async () => {
    await as("outsider");
    expect((await Overview.GET(req("GET"), ctx({ id: wsA }))).status).toBe(404);
    expect((await Evaluations.POST(req("POST", { agentKey: "qa-engineer", datasetId: "qa-engineer" }), ctx({ id: wsA }))).status).toBe(404);
  });

  it("swapping an evaluation id into another workspace's URL does not leak it", async () => {
    await as("member");
    const created = await json(await Evaluations.POST(req("POST", { agentKey: "qa-engineer", datasetId: "qa-engineer" }), ctx({ id: wsA })));
    expect(created.status).toBe(201);
    const evalId = created.body.data.evaluationId;
    // Outsider uses their OWN workspace id with A's evaluation id.
    await as("outsider");
    expect((await EvaluationOne.GET(req("GET"), ctx({ id: wsB, evaluationId: evalId }))).status).toBe(404);
    // And A's own viewer can read it.
    await as("viewer");
    expect((await EvaluationOne.GET(req("GET"), ctx({ id: wsA, evaluationId: evalId }))).status).toBe(200);
  });

  it("an outsider cannot promote A's prompt version via their own workspace", async () => {
    await as("owner");
    const list = await json(await Prompts.GET(req("GET"), ctx({ id: wsA })));
    const v1 = list.body.data.templates.find((t: { key: string }) => t.key === agentPromptKey("ceo")).versions[0];
    await as("outsider");
    const r = await json(await Promote.POST(req("POST", { candidateVersionId: v1.id }), ctx({ id: wsB })));
    expect(r.status).toBe(404);
  });
});

describe("role-based permissions for production changes", () => {
  let draftId: string;

  it("VIEWER can read but cannot create prompt versions or run evaluations", async () => {
    await as("viewer");
    expect((await Prompts.GET(req("GET"), ctx({ id: wsA }))).status).toBe(200);
    expect((await Prompts.POST(req("POST", { templateKey: agentPromptKey("ceo"), content: "x".repeat(30), changelog: "nope" }), ctx({ id: wsA }))).status).toBe(403);
    expect((await Evaluations.POST(req("POST", { agentKey: "ceo", datasetId: "ceo" }), ctx({ id: wsA }))).status).toBe(403);
  });

  it("MEMBER can create a DRAFT but cannot approve, promote, rollback or change routing", async () => {
    await as("member");
    const created = await json(
      await Prompts.POST(req("POST", { templateKey: agentPromptKey("ceo"), content: "You are Ada. Decide with evidence. api_key=sk-ant-REALSECRET123456", changelog: "member draft" }), ctx({ id: wsA })),
    );
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe("DRAFT");
    expect(created.body.data.content).not.toContain("REALSECRET"); // secrets redacted on write
    draftId = created.body.data.id;
    expect((await VersionOne.PATCH(req("PATCH", { status: "APPROVED" }), ctx({ id: wsA, versionId: draftId }))).status).toBe(403);
    expect((await Promote.POST(req("POST", { candidateVersionId: draftId }), ctx({ id: wsA }))).status).toBe(403);
    expect((await Rollback.POST(req("POST", { templateKey: agentPromptKey("ceo"), targetVersionId: draftId, reason: "x x x" }), ctx({ id: wsA }))).status).toBe(403);
    expect((await Models.PUT(req("PUT", { minCorrectness: 0.6 }), ctx({ id: wsA }))).status).toBe(403);
  });

  it("ADMIN promotion of an unevaluated DRAFT is refused (409) and the active version is unchanged", async () => {
    await as("admin");
    const r = await json(await Promote.POST(req("POST", { candidateVersionId: draftId }), ctx({ id: wsA })));
    expect(r.status).toBe(409);
    const active = await prisma.promptVersion.findFirst({ where: { companyId: wsA, status: "ACTIVE", template: { key: agentPromptKey("ceo") } } });
    expect(active!.version).toBe(1);
  });

  it("waiving soft gates requires OWNER", async () => {
    await as("admin");
    expect((await Promote.POST(req("POST", { candidateVersionId: draftId, waiveSoftGates: true }), ctx({ id: wsA }))).status).toBe(403);
  });

  it("ACTIVE cannot be set via the status endpoint (only via gated promotion)", async () => {
    await as("owner");
    const r = await VersionOne.PATCH(req("PATCH", { status: "ACTIVE" }), ctx({ id: wsA, versionId: draftId }));
    expect(r.status).toBe(422); // rejected by the Zod schema
  });

  it("routing policy cannot weaken the security-sensitive floor", async () => {
    await as("admin");
    const r = await json(await Models.PUT(req("PUT", { minSecurity: 0.95, securitySensitive: ["custom-cat"] }), ctx({ id: wsA })));
    expect(r.status).toBe(200);
    const stored = JSON.parse(r.body.data.policy);
    expect(stored.securitySensitiveMinSecurity).toBe(1);
    expect(stored.securitySensitive).toEqual(expect.arrayContaining(["security", "red-team", "custom-cat"]));
    // Lowering the general security floor below 0.9 is a validation error.
    expect((await Models.PUT(req("PUT", { minSecurity: 0.5 }), ctx({ id: wsA }))).status).toBe(422);
    // Unknown keys (e.g. trying to set securitySensitiveMinSecurity) are rejected.
    expect((await Models.PUT(req("PUT", { securitySensitiveMinSecurity: 0 }), ctx({ id: wsA }))).status).toBe(422);
  });
});

describe("validation", () => {
  it("rejects unknown agents and bad bodies with 422", async () => {
    await as("member");
    expect((await Evaluations.POST(req("POST", { agentKey: "root", datasetId: "x" }), ctx({ id: wsA }))).status).toBe(422);
    expect((await Evaluations.POST(req("POST", { agentKey: "ceo", datasetId: "red-team" }), ctx({ id: wsA }))).status).toBe(422);
  });
  it("knowledge approval by MEMBER is forbidden; unknown entry is 404 for ADMIN", async () => {
    await as("member");
    expect((await Knowledge.PATCH(req("PATCH", { action: "approve" }), ctx({ id: wsA, entryId: "nope" }))).status).toBe(403);
    await as("admin");
    expect((await Knowledge.PATCH(req("PATCH", { action: "approve" }), ctx({ id: wsA, entryId: "nope" }))).status).toBe(404);
  });
});
