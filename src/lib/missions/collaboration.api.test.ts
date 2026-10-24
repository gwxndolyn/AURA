/**
 * API-boundary tests for the collaboration routes (real handlers, real authz;
 * only next/headers cookies() is stubbed with a real signed session token).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

let currentToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "aura_session" && currentToken ? { value: currentToken } : undefined), set: () => {} }),
}));

import { prisma } from "@/lib/db";
import { createSessionToken } from "@/lib/auth/session";
import { createCompany } from "@/lib/company/provision";
import { createMission, planMission, decidePlan, runUntilBlocked } from "./engine";
import * as Timeline from "@/app/api/companies/[id]/missions/[missionId]/timeline/route";
import * as HandoffOne from "@/app/api/companies/[id]/missions/[missionId]/handoffs/[handoffId]/route";
import * as RunOne from "@/app/api/companies/[id]/missions/[missionId]/runs/[runId]/route";
import * as Scorecards from "@/app/api/companies/[id]/missions/scorecards/route";

const users: Record<string, { id: string; email: string }> = {};
let wsA: string, wsB: string, missionId: string;
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const req = () => new Request("http://t.local/x");
async function as(n: string | null) {
  currentToken = n ? await createSessionToken({ userId: users[n].id, email: users[n].email }) : null;
}
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as { data?: any } });

beforeAll(async () => {
  const s = Date.now();
  for (const n of ["owner", "viewer", "outsider"]) users[n] = await prisma.user.create({ data: { email: `${n}_${s}@ct.local`, name: n } });
  wsA = (await createCompany({ name: "CT-A", mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
  wsB = (await createCompany({ name: "CT-B", mission: "m", industry: "SaaS", ownerId: users.outsider.id })).id;
  await prisma.workspaceMember.create({ data: { userId: users.viewer.id, companyId: wsA, role: "VIEWER" } });
  const m = await createMission({ companyId: wsA, createdById: users.owner.id, objective: "Inspect the checkout module, identify the cause of a failing validation test, implement a minimal fix, run the relevant tests, and explain the result." });
  missionId = m.id;
  await planMission(m.id, wsA);
  await decidePlan(m.id, wsA, "approve", users.owner.email);
  await runUntilBlocked(m.id, wsA, 40);
}, 240_000);

afterAll(async () => {
  await prisma.company.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
  await prisma.$disconnect();
});

describe("collaboration API", () => {
  it("requires authentication", async () => {
    await as(null);
    expect((await Timeline.GET(req(), ctx({ id: wsA, missionId }))).status).toBe(401);
  });

  it("a viewer sees a timeline built from persisted runs; claims are kept apart from facts", async () => {
    await as("viewer");
    const r = await json(await Timeline.GET(req(), ctx({ id: wsA, missionId })));
    expect(r.status).toBe(200);
    const entries = r.body.data as any[];
    const runs = await prisma.missionTaskRun.count({ where: { missionId } });
    expect(entries.filter((e) => e.id.startsWith("run-"))).toHaveLength(runs);
    expect(entries.some((e) => e.actor.startsWith("human:") && /approved plan/.test(e.action))).toBe(true);
    const fix = entries.find((e) => e.taskKey === "fix" && e.id.startsWith("run-"));
    expect(fix.facts.join()).toMatch(/inside the enforced write scope/);
    expect(typeof fix.claim).toBe("string");
  });

  it("handoff and run detail are scoped to the mission and workspace (IDOR)", async () => {
    const h = await prisma.missionHandoff.findFirst({ where: { missionId } });
    const run = await prisma.missionTaskRun.findFirst({ where: { missionId } });
    await as("viewer");
    expect((await json(await HandoffOne.GET(req(), ctx({ id: wsA, missionId, handoffId: h!.id })))).body.data.valid).toBe(true);
    const rd = await json(await RunOne.GET(req(), ctx({ id: wsA, missionId, runId: run!.id })));
    expect(rd.body.data.contextSources.length).toBeGreaterThan(0);
    await as("outsider");
    expect((await HandoffOne.GET(req(), ctx({ id: wsA, missionId, handoffId: h!.id }))).status).toBe(404);
    expect((await HandoffOne.GET(req(), ctx({ id: wsB, missionId, handoffId: h!.id }))).status).toBe(404);
    expect((await RunOne.GET(req(), ctx({ id: wsB, missionId, runId: run!.id }))).status).toBe(404);
  });

  it("scorecards state denominators and sample confidence", async () => {
    await as("owner");
    const r = await json(await Scorecards.GET(req(), ctx({ id: wsA })));
    const be = (r.body.data as any[]).find((s) => s.agentKey === "backend-engineer");
    expect(be.taskSuccess.denominator).toBe(be.attempts);
    expect(be.confidence.level).toBe("very-low");
    expect(be.taskSuccess.definition).toMatch(/excluded/);
    await as("outsider");
    expect((await Scorecards.GET(req(), ctx({ id: wsA }))).status).toBe(404);
  });
});
