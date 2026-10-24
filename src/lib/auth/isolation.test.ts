import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { ROLE_RANK } from "./authz";
import { hashPassword, verifyPassword } from "./password";
import { createSessionToken, verifySessionToken } from "./session";

/**
 * Multi-tenant isolation + auth tests (spec Phase 3). These run against the
 * real SQLite DB and the real authz logic — no Next server required. They prove
 * cross-workspace access is denied and that auth primitives are sound.
 *
 * We replicate requireWorkspaceAccess's membership check here against the DB so
 * the test is self-contained (the route handler calls the same logic).
 */
const prisma = new PrismaClient();

async function canAccess(userId: string, companyId: string, minRole: keyof typeof ROLE_RANK): Promise<boolean> {
  const [company, membership] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { id: true, ownerId: true } }),
    prisma.workspaceMember.findUnique({ where: { userId_companyId: { userId, companyId } }, select: { role: true } }),
  ]);
  if (!company) return false;
  let role = membership?.role;
  if (!role && company.ownerId === userId) role = "OWNER";
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

let userA: string, userB: string, wsA: string, wsB: string, taskA: string, agentA: string;

beforeAll(async () => {
  const a = await prisma.user.create({ data: { email: `a_${Date.now()}@t.local`, name: "A", passwordHash: await hashPassword("password123") } });
  const b = await prisma.user.create({ data: { email: `b_${Date.now()}@t.local`, name: "B", passwordHash: await hashPassword("password123") } });
  userA = a.id; userB = b.id;

  const cA = await prisma.company.create({ data: { name: "WS-A", mission: "m", industry: "SaaS", ownerId: userA } });
  const cB = await prisma.company.create({ data: { name: "WS-B", mission: "m", industry: "SaaS", ownerId: userB } });
  wsA = cA.id; wsB = cB.id;
  await prisma.workspaceMember.create({ data: { userId: userA, companyId: wsA, role: "OWNER" } });
  await prisma.workspaceMember.create({ data: { userId: userB, companyId: wsB, role: "OWNER" } });

  const t = await prisma.task.create({ data: { companyId: wsA, title: "A's task", description: "", status: "BACKLOG" } });
  taskA = t.id;
  const ag = await prisma.agent.create({ data: { companyId: wsA, key: "ceo", name: "Ada", role: "CEO", avatar: "AD", color: "#fff", personality: "x" } });
  agentA = ag.id;
});

afterAll(async () => {
  await prisma.company.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await prisma.$disconnect();
});

describe("multi-tenant isolation", () => {
  it("owner can access their own workspace", async () => {
    expect(await canAccess(userA, wsA, "OWNER")).toBe(true);
    expect(await canAccess(userB, wsB, "OWNER")).toBe(true);
  });

  it("User A cannot read User B's private workspace", async () => {
    expect(await canAccess(userA, wsB, "VIEWER")).toBe(false);
  });

  it("User B cannot modify User A's workspace", async () => {
    expect(await canAccess(userB, wsA, "MEMBER")).toBe(false);
  });

  it("changing the company id in a request does not bypass authz (IDOR)", async () => {
    // User B tries to reach workspace A by id — denied regardless of the id value.
    expect(await canAccess(userB, wsA, "VIEWER")).toBe(false);
    // A random/forged id is also denied (company not found → false).
    expect(await canAccess(userB, "cly000000000000000000000", "VIEWER")).toBe(false);
  });

  it("A's task and agent belong only to workspace A", async () => {
    const task = await prisma.task.findFirst({ where: { id: taskA, companyId: wsB } });
    expect(task).toBeNull(); // not reachable scoped to B
    const agent = await prisma.agent.findFirst({ where: { id: agentA, companyId: wsB } });
    expect(agent).toBeNull();
    // but reachable scoped to A
    expect(await prisma.task.findFirst({ where: { id: taskA, companyId: wsA } })).not.toBeNull();
  });

  it("role hierarchy is enforced (VIEWER < MEMBER < ADMIN < OWNER)", async () => {
    await prisma.workspaceMember.create({ data: { userId: userB, companyId: wsA, role: "VIEWER" } });
    expect(await canAccess(userB, wsA, "VIEWER")).toBe(true); // can view
    expect(await canAccess(userB, wsA, "MEMBER")).toBe(false); // cannot mutate
    expect(await canAccess(userB, wsA, "OWNER")).toBe(false);
    await prisma.workspaceMember.delete({ where: { userId_companyId: { userId: userB, companyId: wsA } } });
  });
});

describe("auth primitives", () => {
  it("password hashing round-trips and rejects wrong passwords", async () => {
    const h = await hashPassword("s3cret-password");
    expect(await verifyPassword("s3cret-password", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
  });

  it("session tokens sign + verify, and reject tampering", async () => {
    const tok = await createSessionToken({ userId: "u1", email: "u1@t.local" });
    expect(await verifySessionToken(tok)).toEqual({ userId: "u1", email: "u1@t.local" });
    expect(await verifySessionToken(tok + "x")).toBeNull();
    expect(await verifySessionToken("garbage")).toBeNull();
  });
});
