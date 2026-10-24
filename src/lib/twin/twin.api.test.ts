/**
 * Digital twin API boundary tests (real handlers + real authz).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

let currentToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "aura_session" && currentToken ? { value: currentToken } : undefined), set: () => {} }),
}));

import { prisma } from "@/lib/db";
import { createSessionToken } from "@/lib/auth/session";
import { createCompany } from "@/lib/company/provision";
import { SCENARIOS } from "./scenarios";
import * as Twin from "@/app/api/companies/[id]/twin/route";
import * as Config from "@/app/api/companies/[id]/twin/config/route";
import * as Runs from "@/app/api/companies/[id]/twin/runs/route";
import * as RunOne from "@/app/api/companies/[id]/twin/runs/[runId]/route";
import * as Compare from "@/app/api/companies/[id]/twin/compare/route";
import * as Advise from "@/app/api/companies/[id]/twin/advise/route";

const users: Record<string, { id: string; email: string }> = {};
let wsA: string, wsB: string;
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const req = (method = "GET", body?: unknown, url = "http://t.local/x") => new Request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
async function as(n: string | null) {
  currentToken = n ? await createSessionToken({ userId: users[n].id, email: users[n].email }) : null;
}
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as { data?: any; error?: string } });
const D = SCENARIOS.delivery_crunch.defaults;

beforeAll(async () => {
  const s = Date.now();
  for (const n of ["owner", "member", "viewer", "outsider"]) users[n] = await prisma.user.create({ data: { email: `${n}_${s}@twinapi.local`, name: n } });
  wsA = (await createCompany({ name: "TWINAPI-A", mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
  wsB = (await createCompany({ name: "TWINAPI-B", mission: "m", industry: "SaaS", ownerId: users.outsider.id })).id;
  await prisma.workspaceMember.createMany({ data: [{ userId: users.member.id, companyId: wsA, role: "MEMBER" }, { userId: users.viewer.id, companyId: wsA, role: "VIEWER" }] });
}, 60_000);

afterAll(async () => {
  await prisma.company.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
  await prisma.$disconnect();
});

describe("twin API", () => {
  let baseline: string, whatIf: string;
  it("requires auth; viewers read; members run; admins decide", async () => {
    await as(null);
    expect((await Twin.GET(req(), ctx({ id: wsA }))).status).toBe(401);
    await as("viewer");
    const t = await json(await Twin.GET(req(), ctx({ id: wsA })));
    expect(t.body.data.live.departments.map((d: any) => d.key)).toEqual(["product", "engineering", "qa", "infra", "security"]);
    expect(t.body.data.canRun).toBe(false);
    expect((await Runs.POST(req("POST", { scenario: "delivery_crunch", kind: "baseline", decisions: D }), ctx({ id: wsA }))).status).toBe(403);
    await as("member");
    const b = await json(await Runs.POST(req("POST", { scenario: "delivery_crunch", kind: "baseline", decisions: D }), ctx({ id: wsA })));
    expect(b.status).toBe(201);
    baseline = b.body.data.id;
    const w = await json(await Runs.POST(req("POST", { scenario: "delivery_crunch", kind: "what_if", baselineId: baseline, decisions: { ...D, capacity: { qa: 2 } } }), ctx({ id: wsA })));
    whatIf = w.body.data.id;
    const cfg = await json(await Config.GET(req(), ctx({ id: wsA })));
    expect((await Config.PUT(req("PUT", { riskPolicy: "cautious", expectedVersion: cfg.body.data.version }), ctx({ id: wsA }))).status).toBe(403);
    await as("owner");
    expect((await Config.PUT(req("PUT", { riskPolicy: "cautious", expectedVersion: cfg.body.data.version }), ctx({ id: wsA }))).status).toBe(200);
  });

  it("rejects invalid decisions with 422", async () => {
    await as("member");
    const bad = await json(await Runs.POST(req("POST", { scenario: "delivery_crunch", kind: "baseline", decisions: { ...D, allocation: { feature: 1, quality: 1, reliability: 0, security: 0 } } }), ctx({ id: wsA })));
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatch(/sum to 100%/);
    expect((await Runs.DELETE(req("DELETE", undefined, "http://t.local/x?scenario=nope"), ctx({ id: wsA }))).status).toBe(422);
  });

  it("run detail includes the review; reproducibility can be verified over HTTP", async () => {
    await as("viewer");
    const d = await json(await RunOne.GET(req(), ctx({ id: wsA, runId: baseline })));
    expect(d.body.data.review.length).toBeGreaterThan(1);
    const v = await json(await RunOne.POST(req("POST", { action: "verify" }), ctx({ id: wsA, runId: baseline })));
    expect(v.body.data.reproducible).toBe(true);
    const c = await json(await Compare.GET(req("GET", undefined, `http://t.local/x?ids=${baseline},${whatIf}`), ctx({ id: wsA })));
    expect(c.body.data.decisionDiffs[0].diffs).toContain("qa capacity 1 → 2 slots");
  });

  it("the adviser falls back to the engine's explanation without a model", async () => {
    await as("member");
    const a = await json(await Advise.POST(req("POST", { question: "Why did the what-if deliver more?", runIds: [baseline, whatIf] }), ctx({ id: wsA })));
    expect(a.body.data.mode).toBe("deterministic");
    expect(a.body.data.explanation.join(" ")).toMatch(/SIM-CHECKOUT-V2/);
  });

  it("IDOR: another workspace cannot read, compare, save or branch from these runs", async () => {
    await as("outsider");
    expect((await RunOne.GET(req(), ctx({ id: wsA, runId: baseline }))).status).toBe(404);
    expect((await RunOne.GET(req(), ctx({ id: wsB, runId: baseline }))).status).toBe(404);
    expect((await RunOne.POST(req("POST", { action: "save" }), ctx({ id: wsB, runId: whatIf }))).status).toBe(404);
    expect((await Compare.GET(req("GET", undefined, `http://t.local/x?ids=${baseline},${whatIf}`), ctx({ id: wsB }))).status).toBe(404);
    expect((await Runs.POST(req("POST", { scenario: "delivery_crunch", kind: "what_if", baselineId: baseline, decisions: D }), ctx({ id: wsB }))).status).toBe(404);
    const list = await json(await Runs.GET(req(), ctx({ id: wsB })));
    expect(list.body.data.some((r: any) => r.id === baseline)).toBe(false);
  });
});
