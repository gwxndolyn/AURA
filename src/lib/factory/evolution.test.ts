/**
 * V14 product evolution on the real DB, real git repositories and real route
 * handlers (no model calls: proposals and debt come from deterministic
 * analysis of the repository). Fixture app = the node-web starter plus a
 * deliberate maintainability issue (duplicated logic, an uncovered route, an
 * empty catch) and a contract mismatch.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let token: string | null = null;
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (n === "aura_session" && token ? { value: token } : undefined), set: () => {} }) }));

import { prisma } from "@/lib/db";
import { createSessionToken } from "@/lib/auth/session";
import { createCompany } from "@/lib/company/provision";
import { createProduct } from "./store";
import { commitFiles } from "./git";
import { buildIndex } from "@/lib/builder/intel";
import { analyzeDebt, dependencyReview } from "./debt";
import { collectProposals, runCycle, versionState, decide, settleProposals, resumeCycles } from "./maintenance";
import { stackFor } from "@/lib/builder/stacks";
import * as Evolution from "@/app/api/companies/[id]/products/[productId]/evolution/route";
import * as Proposal from "@/app/api/companies/[id]/products/[productId]/evolution/proposals/[proposalId]/route";
import * as Policy from "@/app/api/companies/[id]/products/[productId]/evolution/policy/route";
import * as Integration from "@/app/api/companies/[id]/products/[productId]/integration/route";

const roots: string[] = [];
const users: Record<string, { id: string; email: string }> = {};
let ws = "", other = "", productId = "";
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) as never });
const req = (method = "GET", body?: unknown) => new Request("http://t.local/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const as = async (n: string | null) => { token = n ? await createSessionToken({ userId: users[n].id, email: users[n].email }) : null; };

const DUP = `function total(items) {
  let sum = 0;
  for (const it of items) {
    if (typeof it.amount !== "number") continue;
    sum += Math.round(it.amount * 100);
  }
  const fee = Math.round(sum * 0.02);
  return { sum, fee, net: sum - fee };
}`;
const FIXTURE: Record<string, string> = {
  "src/money.js": `${DUP}\nmodule.exports = { total };\n`,
  "src/report.js": `${DUP.replace("function total", "function totalForReport")}\nmodule.exports = { totalForReport };\n`,
  "src/routes/orders.js": `const { json, readJson } = require("../http");\nconst store = require("../store");\nasync function create(req, res) { try { const b = await readJson(req); return json(res, 201, store.insert("orders", { item: b.item })); } catch (e) {} }\nmodule.exports.routes = [{ method: "POST", pattern: /^\\/api\\/orders$/, handler: create }];\n`,
  "public/app.js": `fetch("/api/order", { method: "POST", headers: {}, body: JSON.stringify({ item }) });\n`,
};

beforeAll(async () => {
  for (const k of ["AURA_GIT_ROOT", "AURA_WORK_ROOT"]) { const d = mkdtempSync(join(tmpdir(), `aura-v14-${k.toLowerCase()}-`)); roots.push(d); process.env[k] = d; }
  const s = Date.now();
  for (const n of ["owner", "member", "viewer", "outsider"]) users[n] = await prisma.user.create({ data: { email: `v14_${n}_${s}@t.local`, name: n } });
  ws = (await createCompany({ name: "V14", mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
  other = (await createCompany({ name: "V14-O", mission: "m", industry: "SaaS", ownerId: users.outsider.id })).id;
  await prisma.subscription.create({ data: { companyId: ws, plan: "team", status: "active" } });
  await prisma.workspaceMember.create({ data: { userId: users.member.id, companyId: ws, role: "MEMBER" } });
  await prisma.workspaceMember.create({ data: { userId: users.viewer.id, companyId: ws, role: "VIEWER" } });
  const r = await createProduct({ companyId: ws, userId: users.owner.id, actor: users.owner.email, idea: "An order tracker used to test product evolution and maintenance." });
  productId = r.product.id;
  const p = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  await commitFiles({ companyId: ws, repoId: p.repoId!, base: "main", branch: "main", files: FIXTURE, message: "existing app with maintainability issues" });
}, 60_000);

afterAll(async () => {
  await prisma.company.deleteMany({ where: { id: { in: [ws, other] } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

describe("technical debt and dependency analysis (accuracy on a labelled fixture)", () => {
  it("finds the planted objective issues and nothing subjective is reported as objective", async () => {
    const files = { ...stackFor("node-web").files, ...FIXTURE };
    const idx = await buildIndex(files);
    const debt = analyzeDebt(idx, files);
    const kinds = debt.map((d) => d.kind);
    expect(kinds).toEqual(expect.arrayContaining(["duplicated_logic", "missing_tests", "unsafe_errors"]));
    const dup = debt.find((d) => d.kind === "duplicated_logic")!;
    expect(dup.files.sort()).toEqual(["src/money.js", "src/report.js"]);
    expect(dup.action).not.toMatch(/rewrite/i);
    expect(debt.filter((d) => d.kind === "dead_code").every((d) => !d.objective)).toBe(true);
    // The clean starter has no planted issue of these kinds (no false positives).
    const clean = analyzeDebt(await buildIndex(stackFor("node-web").files), stackFor("node-web").files);
    expect(clean.filter((d) => ["duplicated_logic", "unsafe_errors", "circular_dependency"].includes(d.kind))).toEqual([]);
  }, 60_000);

  it("dependency review never invents versions or advisories without a registry; newer-only is not a reason", () => {
    const r = dependencyReview({ "package.json": JSON.stringify({ dependencies: { left: "*" } }) });
    expect(r.checks.find((c) => c.id === "registry")!.status).toBe("not_run");
    expect(r.checks.find((c) => c.id === "advisories")!.status).toBe("not_run");
    expect(r.checks.find((c) => c.id === "constraints")!.status).toBe("warning");
    expect(r.updates).toEqual([]);
    const withReg = dependencyReview({ "package.json": JSON.stringify({ dependencies: { a: "^1.0.0", b: "^2.0.0" } }), "package-lock.json": "{}" }, { registry: { a: { latest: "1.4.0" }, b: { latest: "3.0.0", deprecated: "use c" } }, advisories: [] });
    expect(withReg.updates.map((u) => u.name)).toEqual(["b"]); // only the deprecated one; "a is newer" is not worthwhile
    expect(withReg.updates[0].breaking).toBe(true);
  });
});

describe("product lifecycle, proposals and prioritisation", () => {
  it("version state distinguishes workspace code, verified and deployed (never assumed)", async () => {
    const v = await versionState(ws, productId);
    expect(v.latest?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(v.verified).toBeNull();
    expect(v.deployed).toEqual([]);
    expect(v.note).toMatch(/does not assume/);
  }, 60_000);

  it("collects evidence-backed proposals, deduplicates on re-run, closes obsolete ones; mandatory items rank first", async () => {
    const a = await collectProposals(ws, productId);
    const rows = await prisma.improvementProposal.findMany({ where: { productId } });
    expect(rows.length).toBe(a.proposals);
    expect(rows.some((r) => r.source === "debt" && /Duplicated logic/.test(r.title))).toBe(true);
    expect(rows.some((r) => /Integration: public\/app\.js calls POST \/api\/order/.test(r.title))).toBe(true); // contract mismatch from the graph
    expect(a.missingSources.join(" ")).toMatch(/analytics: not connected/);
    await collectProposals(ws, productId);
    expect(await prisma.improvementProposal.count({ where: { productId } })).toBe(rows.length); // duplicates merged
    // A mandatory security proposal outranks everything optional; reprioritising it below optional work is refused.
    const sec = await prisma.improvementProposal.create({ data: { companyId: ws, productId, fingerprint: "sec:test", source: "security", title: "Security: missing ownership check", problem: "x", benefit: "high — security", mandatory: true, approval: "required", lastSeenAt: new Date() } });
    const { prioritize } = await import("./maintenance");
    await prioritize(ws, productId);
    const top = await prisma.improvementProposal.findFirst({ where: { productId, status: "OPEN" }, orderBy: { priority: "desc" } });
    expect(top!.id).toBe(sec.id);
    expect(JSON.parse(top!.priorityWhy)[0]).toMatch(/mandatory/);
    await expect(decide(ws, productId, sec.id, { email: "o", role: "OWNER" }, "reprioritise", 5)).rejects.toThrow(/cannot be ranked below/);
    // Obsolete: evidence gone → closed on the next collection.
    const stale = await prisma.improvementProposal.create({ data: { companyId: ws, productId, fingerprint: "debt:gone", source: "debt", title: "old issue", problem: "x", lastSeenAt: new Date() } });
    await collectProposals(ws, productId);
    expect((await prisma.improvementProposal.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("OBSOLETE");
    await prisma.improvementProposal.update({ where: { id: sec.id }, data: { status: "REJECTED" } });
  }, 60_000);
});

describe("autonomy policies are enforced by the backend", () => {
  it("OBSERVE / RECOMMEND never create tasks; IMPLEMENT_ISOLATED runs only approved work; AUTONOMOUS only low-risk policy work within budget", async () => {
    const tasksBefore = await prisma.backlogItem.count({ where: { productId, milestone: "MAINTENANCE" } });
    for (const mode of ["OBSERVE", "RECOMMEND"]) {
      await prisma.product.update({ where: { id: productId }, data: { maintenanceMode: mode } });
      const r = await runCycle(ws, productId, "test");
      expect(r.executed).toEqual([]);
    }
    expect(await prisma.backlogItem.count({ where: { productId, milestone: "MAINTENANCE" } })).toBe(tasksBefore);
    await prisma.product.update({ where: { id: productId }, data: { maintenanceMode: "IMPLEMENT_ISOLATED" } });
    expect((await runCycle(ws, productId, "test")).executed).toEqual([]); // nothing approved yet
    const dup = (await prisma.improvementProposal.findFirst({ where: { productId, title: { startsWith: "Duplicated logic" } } }))!;
    await decide(ws, productId, dup.id, { email: users.member.email, role: "MEMBER" }, "approve");
    const r = await runCycle(ws, productId, "test");
    expect(r.executed).toEqual([dup.id]);
    const task = await prisma.backlogItem.findFirstOrThrow({ where: { productId, key: (await prisma.improvementProposal.findUniqueOrThrow({ where: { id: dup.id } })).itemKey! } });
    expect(task).toMatchObject({ milestone: "MAINTENANCE", status: "READY", executable: true });
    expect(JSON.parse(task.acceptance)).toContain("All pre-existing tests still pass");
    // AUTONOMOUS: required-approval items are skipped; budget caps the number of changes.
    await prisma.product.update({ where: { id: productId }, data: { maintenanceMode: "AUTONOMOUS", maintenanceBudget: JSON.stringify({ maxChangesPerCycle: 1, maxUnreviewed: 5 }) } });
    const a = await runCycle(ws, productId, "test");
    expect(a.executed.length).toBeLessThanOrEqual(1);
    expect(a.skipped.some((s) => /needs approval|budget/.test(s.why))).toBe(true);
    for (const id of a.executed) expect((await prisma.improvementProposal.findUniqueOrThrow({ where: { id } })).approval).toBe("policy");
  }, 60_000);

  it("security-sensitive approvals need an admin; repeated failures stop retries and escalate", async () => {
    const auth = await prisma.improvementProposal.create({ data: { companyId: ws, productId, fingerprint: "debt:auth", source: "debt", title: "Inconsistent authorization checks in src/auth.js", problem: "x", components: JSON.stringify(["src/auth.js"]), approval: "required", lastSeenAt: new Date() } });
    await expect(decide(ws, productId, auth.id, { email: users.member.email, role: "MEMBER" }, "approve")).rejects.toThrow(/admin must approve/);
    await decide(ws, productId, auth.id, { email: users.owner.email, role: "OWNER" }, "approve");
    await prisma.improvementProposal.update({ where: { id: auth.id }, data: { attempts: 2 } });
    await prisma.product.update({ where: { id: productId }, data: { maintenanceMode: "IMPLEMENT_ISOLATED", maintenanceBudget: JSON.stringify({ maxAttemptsPerIssue: 2 }) } });
    const r = await runCycle(ws, productId, "test");
    expect(r.skipped.find((s) => s.id === auth.id)?.why).toMatch(/escalated/);
    expect((await prisma.improvementProposal.findUniqueOrThrow({ where: { id: auth.id } })).status).toBe("FAILED");
    expect(await prisma.notification.count({ where: { companyId: ws, dedupeKey: `maint-escalate:${auth.id}` } })).toBe(1);
  }, 60_000);

  it("concurrency limit, cancellation and crash recovery of maintenance cycles", async () => {
    const running = await prisma.maintenanceCycle.create({ data: { companyId: ws, productId, mode: "RECOMMEND", createdBy: "x", createdAt: new Date(Date.now() - 120_000), checkpoint: JSON.stringify({ collected: true, step: "collected" }) } });
    await expect(runCycle(ws, productId, "test")).rejects.toThrow(/already running/);
    const resumed = await resumeCycles(ws);
    expect(resumed).toContain(running.id);
    expect((await prisma.maintenanceCycle.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("COMPLETED");
    // A failed maintenance task returns its proposal to APPROVED with the evidence (no silent success).
    const p = await prisma.improvementProposal.findFirstOrThrow({ where: { productId, status: "IN_PROGRESS" } });
    await prisma.backlogItem.updateMany({ where: { productId, key: p.itemKey! }, data: { status: "FAILED" } });
    await settleProposals(ws, productId);
    const after = await prisma.improvementProposal.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe("APPROVED");
    expect(JSON.parse(after.outcome)).toMatchObject({ result: "verification_failed", objectiveMet: false });
  }, 60_000);
});

describe("routes: authorization and isolation", () => {
  it("viewers read, members decide, admins set policy; other tenants get 404", async () => {
    await as("viewer");
    expect((await Evolution.GET(req(), ctx({ id: ws, productId }))).status).toBe(200);
    expect((await Integration.GET(req(), ctx({ id: ws, productId }))).status).toBe(200);
    const p = (await prisma.improvementProposal.findFirst({ where: { productId, status: "OPEN" } }))!;
    expect((await Proposal.POST(req("POST", { decision: "reject" }), ctx({ id: ws, productId, proposalId: p.id }))).status).toBe(403);
    await as("member");
    expect((await Proposal.POST(req("POST", { decision: "no_change" }), ctx({ id: ws, productId, proposalId: p.id }))).status).toBe(200);
    expect((await Policy.POST(req("POST", { mode: "AUTONOMOUS" }), ctx({ id: ws, productId }))).status).toBe(403);
    await as("owner");
    const pol = await Policy.POST(req("POST", { mode: "OBSERVE", budget: { maxChangesPerCycle: 999 } }), ctx({ id: ws, productId }));
    expect(pol.status).toBe(200);
    expect((await pol.json()).data.budget.maxChangesPerCycle).toBe(10); // clamped
    await as("outsider");
    expect((await Evolution.GET(req(), ctx({ id: ws, productId }))).status).toBe(404);
    expect((await Evolution.GET(req(), ctx({ id: other, productId }))).status).toBe(404);
    expect((await Proposal.POST(req("POST", { decision: "approve" }), ctx({ id: other, productId, proposalId: p.id }))).status).toBe(404);
    expect((await Integration.GET(req(), ctx({ id: other, productId }))).status).toBe(404);
    await as(null);
  }, 60_000);
});
