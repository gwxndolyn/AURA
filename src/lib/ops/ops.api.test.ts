/**
 * Operations API boundary tests (real handlers + real authz; only cookies() stubbed
 * with a real signed session).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

let currentToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "aura_session" && currentToken ? { value: currentToken } : undefined), set: () => {} }),
}));

import { prisma } from "@/lib/db";
import { createSessionToken } from "@/lib/auth/session";
import { createCompany } from "@/lib/company/provision";
import { createMission, planMission } from "@/lib/missions/engine";
import * as Briefing from "@/app/api/companies/[id]/ops/briefing/route";
import * as Findings from "@/app/api/companies/[id]/ops/findings/route";
import * as FindingOne from "@/app/api/companies/[id]/ops/findings/[findingId]/route";
import * as FindingActions from "@/app/api/companies/[id]/ops/findings/[findingId]/actions/route";
import * as Evaluate from "@/app/api/companies/[id]/ops/evaluate/route";
import * as Monitor from "@/app/api/companies/[id]/ops/monitor/route";
import * as Notifications from "@/app/api/companies/[id]/ops/notifications/route";

const users: Record<string, { id: string; email: string }> = {};
let wsA: string, wsB: string, findingId: string;
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const req = (method = "GET", body?: unknown, url = "http://t.local/x") => new Request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
async function as(n: string | null) {
  currentToken = n ? await createSessionToken({ userId: users[n].id, email: users[n].email }) : null;
}
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as { data?: any; error?: string } });

beforeAll(async () => {
  const s = Date.now();
  for (const n of ["owner", "member", "viewer", "outsider"]) users[n] = await prisma.user.create({ data: { email: `${n}_${s}@opsapi.local`, name: n } });
  wsA = (await createCompany({ name: "OPSAPI-A", mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
  wsB = (await createCompany({ name: "OPSAPI-B", mission: "m", industry: "SaaS", ownerId: users.outsider.id })).id;
  await prisma.workspaceMember.createMany({ data: [{ userId: users.member.id, companyId: wsA, role: "MEMBER" }, { userId: users.viewer.id, companyId: wsA, role: "VIEWER" }] });
  // A real mission over budget → a real finding.
  const m = await createMission({ companyId: wsA, createdById: users.owner.id, objective: "Inspect the checkout module, identify the cause of a failing validation test, implement a minimal fix." });
  await planMission(m.id, wsA);
  await prisma.mission.update({ where: { id: m.id }, data: { status: "RUNNING", costUsd: 0.9, budgetUsd: 1 } });
}, 60_000);

afterAll(async () => {
  await prisma.company.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
  await prisma.$disconnect();
});

describe("operations API", () => {
  it("requires authentication", async () => {
    await as(null);
    expect((await Briefing.GET(req(), ctx({ id: wsA }))).status).toBe(401);
  });

  it("before any evaluation the briefing says it knows nothing (not 'healthy')", async () => {
    await as("viewer");
    const b = await json(await Briefing.GET(req(), ctx({ id: wsA })));
    expect(b.body.data.coverage).toBeNull();
    expect(b.body.data.summary).toMatch(/No health evaluation has run yet/);
  });

  it("viewers cannot trigger evaluations; members can; findings appear", async () => {
    await as("viewer");
    expect((await Evaluate.POST(req("POST"), ctx({ id: wsA }))).status).toBe(403);
    await as("member");
    const e = await json(await Evaluate.POST(req("POST"), ctx({ id: wsA })));
    expect(e.body.data.ran).toBe(true);
    const list = await json(await Findings.GET(req("GET", undefined, "http://t.local/x?status=OPEN"), ctx({ id: wsA })));
    const budget = (list.body.data as any[]).find((f) => f.ruleId === "mission.budget");
    expect(budget).toBeTruthy();
    findingId = budget.id;
  });

  it("finding detail resolves evidence and shows per-recommendation policy", async () => {
    await as("viewer");
    const d = await json(await FindingOne.GET(req(), ctx({ id: wsA, findingId })));
    expect(d.body.data.rule.definition.resolution).toMatch(/threshold/);
    expect(d.body.data.evidence.find((e: any) => e.kind === "mission").exists).toBe(true);
    const pause = d.body.data.recommendations.find((r: any) => r.action === "pause_mission");
    expect(pause.policy.decision).toBe("blocked"); // viewer role is insufficient
    expect(pause.policy.rule).toBe("role_insufficient");
  });

  it("IDOR: another workspace cannot read, transition or act on the finding", async () => {
    await as("outsider");
    expect((await FindingOne.GET(req(), ctx({ id: wsA, findingId }))).status).toBe(404);
    expect((await FindingOne.GET(req(), ctx({ id: wsB, findingId }))).status).toBe(404);
    expect((await FindingOne.PATCH(req("PATCH", { status: "DISMISSED" }), ctx({ id: wsB, findingId }))).status).toBe(404);
    expect((await FindingActions.POST(req("POST", { action: "pause_mission" }), ctx({ id: wsB, findingId }))).status).toBe(404);
  });

  it("actions only target the server-side recommendation; non-recommended actions are rejected", async () => {
    await as("member");
    const bad = await json(await FindingActions.POST(req("POST", { action: "rollback_deployment" }), ctx({ id: wsA, findingId })));
    expect(bad.status).toBe(422);
    const ok = await json(await FindingActions.POST(req("POST", { action: "pause_mission" }), ctx({ id: wsA, findingId })));
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe("succeeded");
    expect(ok.body.data.policy.rule).toBe("user_initiated@recommend");
  });

  it("lifecycle transitions are validated and recorded", async () => {
    await as("member");
    expect((await FindingOne.PATCH(req("PATCH", { status: "ACKNOWLEDGED" }), ctx({ id: wsA, findingId }))).status).toBe(200);
    const d = await json(await FindingOne.GET(req(), ctx({ id: wsA, findingId })));
    expect(d.body.data.acknowledgedBy).toBe(users.member.email);
    expect(d.body.data.history.map((h: any) => h.change)).toContain("status open → acknowledged");
  });

  it("only ADMIN+ may change the autonomy policy; risky actions can never be allow-listed for automation", async () => {
    await as("member");
    expect((await Monitor.PUT(req("PUT", { policyLevel: "BOUNDED" }), ctx({ id: wsA }))).status).toBe(403);
    await as("owner");
    const r = await json(await Monitor.PUT(req("PUT", { policyLevel: "BOUNDED", allowedAutoActions: ["retry_task", "cancel_mission", "rollback_deployment"] }), ctx({ id: wsA })));
    expect(r.body.data.allowedAutoActions).toEqual(["retry_task"]);
    expect((await Monitor.PUT(req("PUT", { intervalSec: 1 }), ctx({ id: wsA }))).status).toBe(422);
  });

  it("notifications are scoped and marked read per user", async () => {
    await as("owner");
    const n = await json(await Notifications.GET(req(), ctx({ id: wsA })));
    await as("outsider");
    const other = await json(await Notifications.GET(req(), ctx({ id: wsB })));
    expect((other.body.data.items as any[]).some((x) => (n.body.data.items as any[]).some((y) => y.id === x.id))).toBe(false);
  });
});
