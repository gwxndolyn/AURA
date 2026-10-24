/**
 * Development workspace API boundary tests: real route handlers + real authz
 * (only cookies() is stubbed with a real signed session).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

let currentToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "aura_session" && currentToken ? { value: currentToken } : undefined), set: () => {} }),
}));

import { prisma } from "@/lib/db";
import { createSessionToken } from "@/lib/auth/session";
import { createCompany } from "@/lib/company/provision";
import * as Tree from "@/app/api/companies/[id]/devspace/route";
import * as File from "@/app/api/companies/[id]/devspace/file/route";
import * as Import from "@/app/api/companies/[id]/devspace/import/route";
import * as Checks from "@/app/api/companies/[id]/devspace/checks/route";
import * as CheckOne from "@/app/api/companies/[id]/devspace/checks/[runId]/route";
import * as ChangeOne from "@/app/api/companies/[id]/devspace/changes/[changeId]/route";

const users: Record<string, { id: string; email: string }> = {};
let wsA: string, wsB: string;
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const req = (method = "GET", body?: unknown, url = "http://t.local/x") => new Request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
async function as(n: string | null) {
  currentToken = n ? await createSessionToken({ userId: users[n].id, email: users[n].email }) : null;
}
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as { data?: any; error?: string } });

beforeAll(async () => {
  const s = Date.now();
  for (const n of ["owner", "member", "viewer", "outsider"]) users[n] = await prisma.user.create({ data: { email: `${n}_${s}@devapi.local`, name: n } });
  wsA = (await createCompany({ name: "DEVAPI-A", mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
  wsB = (await createCompany({ name: "DEVAPI-B", mission: "m", industry: "SaaS", ownerId: users.outsider.id })).id;
  await prisma.workspaceMember.createMany({ data: [{ userId: users.member.id, companyId: wsA, role: "MEMBER" }, { userId: users.viewer.id, companyId: wsA, role: "VIEWER" }] });
}, 60_000);

afterAll(async () => {
  await prisma.company.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
  await prisma.$disconnect();
});

describe("devspace API", () => {
  it("requires authentication", async () => {
    await as(null);
    expect((await Tree.GET(req(), ctx({ id: wsA }))).status).toBe(401);
  });

  it("viewer can read but not edit or import; capabilities reflect the role", async () => {
    await as("member");
    expect((await Import.POST(req("POST", { template: "checkout-validation" }), ctx({ id: wsA }))).status).toBe(200);
    await as("viewer");
    const t = await json(await Tree.GET(req(), ctx({ id: wsA })));
    expect(t.body.data.canEdit).toBe(false);
    expect(t.body.data.files.map((f: any) => f.path)).toContain("src/checkout/validation.js");
    expect(t.body.data.preview.available).toBe(false);
    const f = await json(await File.GET(req("GET", undefined, "http://t.local/x?path=src/checkout/validation.js"), ctx({ id: wsA })));
    expect(f.body.data.rev).toBe(1);
    expect((await File.PUT(req("PUT", { path: "src/checkout/validation.js", content: "x", expectedRev: 1 }), ctx({ id: wsA }))).status).toBe(403);
  });

  it("path traversal and protected files are refused over HTTP", async () => {
    await as("member");
    for (const p of ["../../../etc/passwd", "/etc/passwd", "src/../../x"]) expect((await File.GET(req("GET", undefined, `http://t.local/x?path=${encodeURIComponent(p)}`), ctx({ id: wsA }))).status).toBe(422);
    expect((await File.PUT(req("PUT", { path: ".env", content: "SECRET=1", expectedRev: 0 }), ctx({ id: wsA }))).status).toBe(422);
  });

  it("stale saves get 409 instead of overwriting", async () => {
    await as("member");
    expect((await File.PUT(req("PUT", { path: "src/checkout/validation.js", content: "// a\n", expectedRev: 1 }), ctx({ id: wsA }))).status).toBe(200);
    const stale = await json(await File.PUT(req("PUT", { path: "src/checkout/validation.js", content: "// b\n", expectedRev: 1 }), ctx({ id: wsA })));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/changed since you opened it/);
  });

  it("checks accept only allowlisted ids, never commands", async () => {
    await as("member");
    expect((await Checks.POST(req("POST", { check: "rm -rf /" }), ctx({ id: wsA }))).status).toBe(422);
    const r = await json(await Checks.POST(req("POST", { check: "typecheck" }), ctx({ id: wsA })));
    expect(r.body.data.status).toBe("UNSUPPORTED");
  });

  it("another workspace cannot read files, runs or changes (IDOR)", async () => {
    const run = await prisma.execRun.findFirst({ where: { companyId: wsA } });
    await as("outsider");
    expect((await File.GET(req("GET", undefined, "http://t.local/x?path=src/checkout/validation.js"), ctx({ id: wsA }))).status).toBe(404);
    // Their own workspace id + A's run id → not found.
    expect((await CheckOne.GET(req(), ctx({ id: wsB, runId: run!.id }))).status).toBe(404);
    expect((await CheckOne.DELETE(req("DELETE"), ctx({ id: wsB, runId: run!.id }))).status).toBe(404);
    expect((await ChangeOne.GET(req(), ctx({ id: wsB, changeId: "nope" }))).status).toBe(404);
    // B's own project does not contain A's files.
    const b = await json(await Tree.GET(req(), ctx({ id: wsB })));
    expect(b.body.data.files.map((f: any) => f.path)).not.toContain("src/checkout/validation.js");
  });

  it("only ADMIN+ may accept/revert; members may reject", async () => {
    await as("member");
    expect((await ChangeOne.POST(req("POST", { action: "accept", confirmHighRisk: true }), ctx({ id: wsA, changeId: "nope" }))).status).toBe(403);
    expect((await ChangeOne.POST(req("POST", { action: "reject" }), ctx({ id: wsA, changeId: "nope" }))).status).toBe(404);
  });
});
