/**
 * Demo workspace + mission API tests through the REAL route handlers. The only
 * stub is next/headers cookies(), fed a real HMAC-signed session token, so
 * authentication and requireWorkspaceAccess run for real.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

let currentToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "aura_session" && currentToken ? { value: currentToken } : undefined),
    set: () => {},
  }),
}));

import { AGENT_DEFS } from "@/lib/agents/definitions";
import { prisma } from "@/lib/db";
import { createSessionToken } from "@/lib/auth/session";
import { createCompany } from "@/lib/company/provision";
import { dockerAvailable } from "@/lib/sandbox/runner";
import * as Demo from "@/app/api/demo/route";
import * as Reset from "@/app/api/companies/[id]/demo/reset/route";
import * as Missions from "@/app/api/companies/[id]/missions/route";
import * as Example from "@/app/api/companies/[id]/missions/example/route";
import * as MissionOne from "@/app/api/companies/[id]/missions/[missionId]/route";
import * as Plan from "@/app/api/companies/[id]/missions/[missionId]/plan/route";
import * as Advance from "@/app/api/companies/[id]/missions/[missionId]/advance/route";
import * as Approval from "@/app/api/companies/[id]/missions/[missionId]/approvals/[approvalId]/route";
import * as Report from "@/app/api/companies/[id]/missions/[missionId]/report/route";
import * as Onboarding from "@/app/api/onboarding/route";

const users: Record<string, { id: string; email: string }> = {};
const created: string[] = [];
let docker = false;
let demoA: string, demoB: string, realWs: string;

async function as(name: keyof typeof users | null) {
  currentToken = name ? await createSessionToken({ userId: users[name].id, email: users[name].email }) : null;
}
function req(method: string, body?: unknown) {
  return new Request("http://test.local/x", { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: any; error?: string } };
}

beforeAll(async () => {
  docker = await dockerAvailable();
  const stamp = Date.now();
  for (const r of ["alice", "bob", "member", "viewer"]) {
    const u = await prisma.user.create({ data: { email: `${r}_${stamp}@demo.local`, name: r } });
    users[r] = { id: u.id, email: u.email };
  }
  realWs = (await createCompany({ name: "REAL-WS", mission: "m", industry: "SaaS", ownerId: users.alice.id })).id;
  created.push(realWs);
}, 60_000);

afterAll(async () => {
  currentToken = null;
  await prisma.company.deleteMany({ where: { id: { in: created } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
  await prisma.$disconnect();
});

describe("demo entry and isolation", () => {
  it("requires authentication", async () => {
    await as(null);
    expect((await Demo.POST(req("POST"), undefined as never)).status).toBe(401);
  });

  it("creates one demo workspace per user, seeded by real engines", async () => {
    await as("alice");
    const r = await json(await Demo.POST(req("POST"), undefined as never));
    expect(r.status).toBe(201);
    demoA = r.body.data.companyId;
    created.push(demoA);
    const steps = r.body.data.baseline as { step: string; ok: boolean; detail: string }[];
    expect(steps.length).toBeGreaterThanOrEqual(7);
    expect(steps.filter((s) => !s.ok)).toEqual([]);
    // Every step reports a real outcome; the checkout sample needs Docker to reach its gate.
    const checkout = steps.find((s) => /checkout/.test(s.step))!;
    expect(checkout.ok).toBe(true);
    expect(checkout.detail).toMatch(docker ? /paused/ : /failed/);
    // Second call returns the same workspace (idempotent).
    const again = await json(await Demo.POST(req("POST"), undefined as never));
    expect(again.status).toBe(200);
    expect(again.body.data.companyId).toBe(demoA);
  }, 240_000);

  it("seeded missions span states and are read-only, never pre-approved by a human", async () => {
    const ms = await prisma.mission.findMany({ where: { companyId: demoA } });
    expect(ms.every((m) => m.source === "SEEDED")).toBe(true);
    const statuses = new Set(ms.map((m) => m.status));
    expect(statuses.has("COMPLETED")).toBe(true);
    expect(statuses.has("AWAITING_APPROVAL")).toBe(true);
    expect(statuses.has("CANCELLED")).toBe(true);
    expect(await prisma.missionApproval.count({ where: { companyId: demoA, status: "APPROVED" } })).toBe(0);
    const plans = await prisma.missionPlan.findMany({ where: { companyId: demoA, status: "APPROVED" } });
    expect(plans.every((p) => p.decidedBy === "demo-setup")).toBe(true);
    // Driving a sample mission is refused.
    await as("alice");
    const seeded = ms.find((m) => m.status === "AWAITING_APPROVAL")!;
    const r = await json(await Plan.POST(req("POST", { action: "approve" }), ctx({ id: demoA, missionId: seeded.id })));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/read-only/);
  });

  it("another user gets their own demo and cannot see Alice's", async () => {
    await as("bob");
    const r = await json(await Demo.POST(req("POST"), undefined as never));
    demoB = r.body.data.companyId;
    created.push(demoB);
    expect(demoB).not.toBe(demoA);
    expect((await Missions.GET(req("GET"), ctx({ id: demoA }))).status).toBe(404);
    const aMission = await prisma.mission.findFirst({ where: { companyId: demoA } });
    // IDOR: Bob's own workspace id + Alice's mission id.
    expect((await MissionOne.GET(req("GET"), ctx({ id: demoB, missionId: aMission!.id }))).status).toBe(404);
    expect((await Report.GET(req("GET"), ctx({ id: demoB, missionId: aMission!.id }))).status).toBe(404);
  }, 240_000);
});

describe("example mission through the API", () => {
  let missionId: string;

  it("Run example mission creates the user's own copy, planned but not running", async () => {
    await as("alice");
    const before = await prisma.mission.count({ where: { companyId: demoA, source: "SEEDED" } });
    const r = await json(await Example.POST(req("POST"), ctx({ id: demoA })));
    expect(r.status).toBe(201);
    missionId = r.body.data.id;
    const m = await prisma.mission.findUnique({ where: { id: missionId } });
    expect(m!.source).toBe("EXAMPLE");
    expect(m!.status).toBe("AWAITING_APPROVAL");
    expect(await prisma.mission.count({ where: { companyId: demoA, source: "SEEDED" } })).toBe(before);
    const adv = await json(await Advance.POST(req("POST", { steps: 5 }), ctx({ id: demoA, missionId })));
    expect(adv.body.data.waitingOn).toBe("plan approval");
  }, 60_000);

  it("runs to the gate; only an ADMIN+ human may decide; the report reflects persisted state", async () => {
    await as("alice");
    await json(await Plan.POST(req("POST", { action: "approve" }), ctx({ id: demoA, missionId })));
    let status = "";
    for (let i = 0; i < 12; i++) {
      const a = await json(await Advance.POST(req("POST", { steps: 5 }), ctx({ id: demoA, missionId })));
      status = a.body.data.status;
      if (!a.body.data.progressed || ["PAUSED", "FAILED", "COMPLETED"].includes(status)) break;
    }
    if (!docker) {
      expect(status).toBe("FAILED");
      const rep = await json(await Report.GET(req("GET"), ctx({ id: demoA, missionId })));
      expect(rep.body.data.criteria.find((c: any) => /tests pass/i.test(c.text)).status).not.toBe("met");
      return;
    }
    expect(status).toBe("PAUSED");
    const detail = await json(await MissionOne.GET(req("GET"), ctx({ id: demoA, missionId })));
    const approval = detail.body.data.approvals.find((x: any) => x.status === "PENDING");
    expect(approval).toBeTruthy();
    expect(approval.payloadHash).toBeUndefined(); // integrity hash is server-only

    // A MEMBER cannot approve the gate.
    await prisma.workspaceMember.create({ data: { userId: users.member.id, companyId: demoA, role: "MEMBER" } });
    await as("member");
    expect((await Approval.POST(req("POST", { decision: "approve" }), ctx({ id: demoA, missionId, approvalId: approval.id }))).status).toBe(403);
    // Bob cannot approve via his own workspace id.
    await as("bob");
    expect((await Approval.POST(req("POST", { decision: "approve" }), ctx({ id: demoB, missionId, approvalId: approval.id }))).status).toBe(404);

    await as("alice");
    const ok = await json(await Approval.POST(req("POST", { decision: "approve", note: "diff reviewed" }), ctx({ id: demoA, missionId, approvalId: approval.id })));
    expect(ok.status).toBe(200);
    for (let i = 0; i < 4; i++) {
      const a = await json(await Advance.POST(req("POST", { steps: 5 }), ctx({ id: demoA, missionId })));
      status = a.body.data.status;
      if (status === "COMPLETED" || !a.body.data.progressed) break;
    }
    expect(status).toBe("COMPLETED");
    const rep = (await json(await Report.GET(req("GET"), ctx({ id: demoA, missionId })))).body.data;
    expect(rep.finalTest.mode).toBe("docker");
    expect(rep.finalTest.failed).toBe(0);
    expect(rep.ledger.humanApproved).toBe(1);
    expect(rep.ledger.deployed).toBe(0);
    expect(rep.approvals[0].decidedBy).toBe(users.alice.email);
  }, 240_000);

  it("viewers can read but not drive missions", async () => {
    await prisma.workspaceMember.create({ data: { userId: users.viewer.id, companyId: demoA, role: "VIEWER" } });
    await as("viewer");
    expect((await Missions.GET(req("GET"), ctx({ id: demoA }))).status).toBe(200);
    expect((await Example.POST(req("POST"), ctx({ id: demoA }))).status).toBe(403);
    expect((await Missions.POST(req("POST", { objective: "Do something useful for customers" }), ctx({ id: demoA }))).status).toBe(403);
  });
});

describe("demo reset", () => {
  it("refuses non-owners, non-demo workspaces, and missing confirmation", async () => {
    await as("member");
    expect((await Reset.POST(req("POST", { confirm: "RESET" }), ctx({ id: demoA }))).status).toBe(403);
    await as("alice");
    expect((await Reset.POST(req("POST", { confirm: "RESET" }), ctx({ id: realWs }))).status).toBe(403);
    expect((await Reset.POST(req("POST", {}), ctx({ id: demoA }))).status).toBe(422);
  });

  it("refuses a concurrent reset while one holds the lock", async () => {
    await prisma.company.update({ where: { id: demoA }, data: { demoLockUntil: new Date(Date.now() + 60_000) } });
    await as("alice");
    const r = await json(await Reset.POST(req("POST", { confirm: "RESET" }), ctx({ id: demoA })));
    expect(r.status).toBe(409);
    await prisma.company.update({ where: { id: demoA }, data: { demoLockUntil: null } });
  });

  it("restores the baseline for this workspace only; other tenants are untouched", async () => {
    const userMission = await prisma.mission.create({ data: { companyId: realWs, createdById: users.alice.id, title: "keep me", objective: "keep this mission intact" } });
    const bobBefore = await prisma.mission.count({ where: { companyId: demoB } });
    const auditBefore = await prisma.auditLog.count({ where: { companyId: demoA } });
    await as("alice");
    const r = await json(await Reset.POST(req("POST", { confirm: "RESET" }), ctx({ id: demoA })));
    expect(r.status).toBe(200);
    expect(r.body.data.baseline.length).toBeGreaterThanOrEqual(7);
    // User-created example mission is gone; baseline samples are back.
    expect(await prisma.mission.count({ where: { companyId: demoA, source: "EXAMPLE" } })).toBe(0);
    expect(await prisma.mission.count({ where: { companyId: demoA, source: "SEEDED" } })).toBe(4);
    expect(await prisma.agent.count({ where: { companyId: demoA } })).toBe(AGENT_DEFS.length);
    // Other tenants untouched; audit history preserved; lock released.
    expect(await prisma.mission.findUnique({ where: { id: userMission.id } })).not.toBeNull();
    expect(await prisma.mission.count({ where: { companyId: demoB } })).toBe(bobBefore);
    expect(await prisma.auditLog.count({ where: { companyId: demoA } })).toBeGreaterThan(auditBefore);
    expect((await prisma.company.findUnique({ where: { id: demoA } }))!.demoLockUntil).toBeNull();
    // Memberships survive the reset.
    expect(await prisma.workspaceMember.count({ where: { companyId: demoA } })).toBe(3);
  }, 240_000);
});

describe("onboarding persistence", () => {
  it("records steps, skip, restart and completion per user", async () => {
    await as("alice");
    let s = (await json(await Onboarding.GET(req("GET"), undefined as never))).body.data;
    expect(s.steps).toEqual([]);
    await Onboarding.POST(req("POST", { action: "step", step: "open-demo", companyId: demoA }), undefined as never);
    await Onboarding.POST(req("POST", { action: "skip" }), undefined as never);
    s = (await json(await Onboarding.GET(req("GET"), undefined as never))).body.data;
    expect(s.steps).toEqual(["open-demo"]);
    expect(s.skippedAt).toBeTruthy();
    // Bob's progress is separate.
    await as("bob");
    expect((await json(await Onboarding.GET(req("GET"), undefined as never))).body.data.steps).toEqual([]);
    // Bob cannot write audit entries into Alice's workspace.
    expect((await Onboarding.POST(req("POST", { action: "step", step: "open-demo", companyId: demoA }), undefined as never)).status).toBe(404);
    await as("alice");
    await Onboarding.POST(req("POST", { action: "restart" }), undefined as never);
    s = (await json(await Onboarding.GET(req("GET"), undefined as never))).body.data;
    expect(s.steps).toEqual([]);
    expect(s.skippedAt).toBeUndefined();
    for (const step of ["open-demo", "view-missions", "run-example", "approve-plan", "inspect-evidence", "decide-gate", "read-report"]) {
      await Onboarding.POST(req("POST", { action: "step", step }), undefined as never);
    }
    expect((await json(await Onboarding.GET(req("GET"), undefined as never))).body.data.completedAt).toBeTruthy();
    expect((await Onboarding.POST(req("POST", { action: "step", step: "not-a-step" }), undefined as never)).status).toBe(422);
  });
});
