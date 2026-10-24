/**
 * Office API boundary: real route handler + real authz. The office reflects
 * persisted mission state (a real plan → real tasks → mapped activity) and is
 * invisible to other workspaces.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

let currentToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "aura_session" && currentToken ? { value: currentToken } : undefined), set: () => {} }),
}));

import { prisma } from "@/lib/db";
import { createSessionToken } from "@/lib/auth/session";
import { createCompany } from "@/lib/company/provision";
import { createMission, planMission, decidePlan } from "@/lib/missions/engine";
import { mapOfficeState } from "./state";
import * as Office from "@/app/api/companies/[id]/office/route";

const users: Record<string, { id: string; email: string }> = {};
let wsA: string, wsB: string, missionId: string;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://t.local/x");
async function as(n: string | null) {
  currentToken = n ? await createSessionToken({ userId: users[n].id, email: users[n].email }) : null;
}

beforeAll(async () => {
  const s = Date.now();
  for (const n of ["owner", "viewer", "outsider"]) users[n] = await prisma.user.create({ data: { email: `${n}_${s}@officeapi.local`, name: n } });
  wsA = (await createCompany({ name: "OFFICE-A", mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
  wsB = (await createCompany({ name: "OFFICE-B", mission: "m", industry: "SaaS", ownerId: users.outsider.id })).id;
  await prisma.workspaceMember.create({ data: { userId: users.viewer.id, companyId: wsA, role: "VIEWER" } });
  const m = await createMission({ companyId: wsA, createdById: users.owner.id, objective: "Find and fix a validation bug in a sample checkout module: fix the failing validation test, run the tests." });
  missionId = m.id;
  await planMission(m.id, wsA);
  await decidePlan(m.id, wsA, "approve", users.owner.email);
}, 60_000);

afterAll(async () => {
  await prisma.company.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
  await prisma.$disconnect();
});

describe("GET /api/companies/[id]/office", () => {
  it("requires a session and workspace membership (401 / 404, no existence leak)", async () => {
    await as(null);
    expect((await Office.GET(req(), ctx(wsA))).status).toBe(401);
    await as("outsider");
    expect((await Office.GET(req(), ctx(wsA))).status).toBe(404);
    expect((await Office.GET(req(), ctx("does-not-exist"))).status).toBe(404);
  });

  it("returns real agents and the approved mission's tasks to a viewer; the mapper places them honestly", async () => {
    await as("viewer");
    const r = await Office.GET(req(), ctx(wsA));
    expect(r.status).toBe(200);
    const d = (await r.json()).data;
    expect(d.agents.map((a: { key: string }) => a.key)).toContain("qa-engineer");
    const keys = d.tasks.filter((t: { missionId: string }) => t.missionId === missionId).map((t: { key: string }) => t.key);
    expect(keys).toEqual(expect.arrayContaining(["requirements", "fix", "verify"]));
    expect(d.tasks.every((t: { missionId: string }) => t.missionId === missionId)).toBe(true);
    const v = mapOfficeState({ agents: d.agents, tasks: d.tasks, work: d.work, interactions: d.interactions, now: Date.parse(d.now) });
    // Nothing has executed yet: nobody is shown coding/testing, only queued work.
    expect(v.filter((x) => ["coding", "testing", "reviewing", "completed"].includes(x.activity))).toEqual([]);
    expect(v.find((x) => x.key === "backend-engineer")!.queued).toBeGreaterThan(0);
  });

  it("another workspace's office never includes this workspace's tasks", async () => {
    await as("outsider");
    const d = (await (await Office.GET(req(), ctx(wsB))).json()).data;
    expect(d.tasks).toEqual([]);
    expect(JSON.stringify(d)).not.toContain(missionId);
  });
});
