/**
 * AURA V3 acceptance tests (factory level). Real: Prisma DB, job queue,
 * scheduler, git repositories, route handlers + authz. Test double: ONLY the
 * model provider's HTTP endpoint (test/doubles/anthropic.ts), which scripts
 * the PM's brief/backlog. Nothing here needs Docker; engine runs that need
 * the sandbox are covered by src/lib/builder/builder.test.ts (skipped, not
 * faked, without Docker).
 *
 * Covers acceptance 1–4, 6, 11–13, 15–18, 20 (see docs/implementation-status.md).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let currentToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "aura_session" && currentToken ? { value: currentToken } : undefined), set: () => {} }),
}));

import { prisma } from "@/lib/db";
import { createSessionToken } from "@/lib/auth/session";
import { createCompany } from "@/lib/company/provision";
import { resetClientForTests } from "@/lib/ai/claude";
import { drain } from "@/lib/jobs/worker";
import { startAnthropicDouble, text, type Double } from "../../../test/doubles/anthropic";
import { BRIEF } from "../../../test/doubles/scamscout";
import { createProduct, reviseBrief, setItemStatus } from "./store";
import { tickProduct } from "./scheduler";
import { decideProductApproval, rollbackItem } from "./release";
import { productDetail } from "./read";
import { evaluateGate, deliveryReport } from "./gate";
import { listMemory } from "./memory";
import { startBuild, cancelBuild, recoverOrphanedBuilds } from "@/lib/builder/service";
import { runBuild } from "@/lib/builder/engine";
import { bareDir, readAt, commitFiles } from "./git";
import * as GateRoute from "@/app/api/companies/[id]/products/[productId]/gate/route";
import * as MemoryRoute from "@/app/api/companies/[id]/products/[productId]/memory/route";
import * as RollbackRoute from "@/app/api/companies/[id]/products/[productId]/items/[key]/rollback/route";
import * as DefectsRoute from "@/app/api/companies/[id]/products/[productId]/defects/route";
import * as IntelRoute from "@/app/api/companies/[id]/products/[productId]/intel/route";

const IDEA = "Build a job scam checker where users paste a listing, get a risk score, and see their past checks.";
const V3_BRIEF = { ...BRIEF, functional: [{ id: "FR-1", text: "Users can submit a job listing and get a risk assessment" }, { id: "FR-2", text: "Users can see a history of their past checks" }], acceptance: [{ id: "AC-1", text: "Listings asking for upfront payment are rated high risk", measurable: true }] };
const task = (key: string, title: string, files: string[], dependsOn: string[], requirements: string[]) => ({ key, title, description: `${title}.`, kind: "BACKEND", acceptance: [`${title} works`], dependsOn, effort: 2, risk: "LOW", files, requirements });
const V3_BACKLOG = { epics: [{ key: "E1", title: "MVP", stories: [{ key: "E1.S1", title: "Assess and review listings", acceptance: ["Assessments work"], milestone: "M1", tasks: [
  task("E1.S1.T1", "Risk scoring API", ["src/routes/assessments.js"], [], ["FR-1", "AC-1"]),
  task("E1.S1.T2", "History store", ["src/history.js"], [], ["FR-2"]),
  task("E1.S1.T3", "Scoring explanations", ["src/routes/assessments.js"], [], ["FR-1"]),
  task("E1.S1.T4", "History API", ["src/routes/history.js"], ["E1.S1.T1"], ["FR-2"]),
] }] }] };

const users: Record<string, { id: string; email: string }> = {};
let ws: string, otherWs: string, productId: string, double: Double;
const roots: string[] = [];
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const req = (method = "GET", body?: unknown, url = "http://t.local/x") => new Request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const as = async (n: string | null) => { currentToken = n ? await createSessionToken({ userId: users[n].id, email: users[n].email }) : null; };
const items = async () => (await productDetail(ws, productId)).items;

beforeAll(async () => {
  for (const k of ["AURA_GIT_ROOT", "AURA_WORK_ROOT"]) {
    const d = mkdtempSync(join(tmpdir(), `aura-v3-${k.toLowerCase()}-`));
    roots.push(d);
    process.env[k] = d;
  }
  double = await startAnthropicDouble((r) => [text(JSON.stringify(/backlog/i.test(r.system) ? V3_BACKLOG : V3_BRIEF))]);
  process.env.ANTHROPIC_API_KEY = "test-key-for-double";
  process.env.ANTHROPIC_BASE_URL = double.url;
  resetClientForTests();
  const s = Date.now();
  for (const n of ["owner", "member", "viewer", "outsider"]) users[n] = await prisma.user.create({ data: { email: `${n}_${s}@v3.local`, name: n } });
  ws = (await createCompany({ name: "V3", mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
  otherWs = (await createCompany({ name: "V3-O", mission: "m", industry: "SaaS", ownerId: users.outsider.id })).id;
  await prisma.workspaceMember.createMany({ data: [{ userId: users.member.id, companyId: ws, role: "MEMBER" }, { userId: users.viewer.id, companyId: ws, role: "VIEWER" }] });
  await prisma.subscription.create({ data: { companyId: ws, plan: "pro", status: "active" } });
}, 60_000);

afterAll(async () => {
  await double.close();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  resetClientForTests();
  await prisma.company.deleteMany({ where: { id: { in: [ws, otherWs] } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
  await prisma.$disconnect();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

describe("V3: from request to a traceable, scheduled plan", () => {
  it("1–2: a natural-language request becomes a persisted brief with requirements, and every task traces to them", async () => {
    const r = await createProduct({ companyId: ws, userId: users.owner.id, actor: users.owner.email, idea: IDEA, limits: { maxParallel: 3 } });
    productId = r.product.id;
    for (let i = 0; i < 40 && (await prisma.product.findUnique({ where: { id: productId } }))?.planningStatus !== "READY"; i++) if (!(await drain(1, [ws]))) await new Promise((r) => setTimeout(r, 100));
    const d = await productDetail(ws, productId);
    expect(d.product.planningStatus).toBe("READY");
    expect((d.brief!.content as typeof V3_BRIEF).functional.map((f) => f.id)).toEqual(["FR-1", "FR-2"]);
    const t1 = await prisma.backlogItem.findFirst({ where: { productId, key: "E1.S1.T1" } });
    expect(JSON.parse(t1!.requirements)).toEqual(["FR-1", "AC-1"]);
    expect(JSON.parse(t1!.acceptance)).toHaveLength(1);
    // Brief assumptions are remembered as labelled assumptions, not facts.
    expect((await listMemory(ws, productId)).filter((m) => m.key.startsWith("assumption:")).every((m) => m.status === "ASSUMPTION")).toBe(true);
  }, 60_000);

  it("3–4: only dependency-free tasks start; independent work runs concurrently; tasks sharing files never overlap", async () => {
    const scope = (await productDetail(ws, productId)).approvals.find((a) => a.action === "scope")!;
    await decideProductApproval(ws, productId, scope.id, users.owner.email, "approve");
    const t = await tickProduct(ws, productId);
    expect(t.dispatched.sort()).toEqual(["E1.S1.T1", "E1.S1.T2"]);
    expect(t.waitingOn.some((w) => w.startsWith("E1.S1.T3") && /shares files/.test(w))).toBe(true);
    const st = Object.fromEntries((await items()).map((i) => [i.key, i.status]));
    expect(st["E1.S1.T4"]).toBe("TODO"); // depends on T1, not ready
    expect(await prisma.build.count({ where: { productId, status: "QUEUED" } })).toBe(2);
  });

  it("12: duplicate dispatch / job delivery causes no duplicate side effects", async () => {
    const before = await prisma.build.count({ where: { productId } });
    const again = await tickProduct(ws, productId);
    expect(again.dispatched).toEqual([]);
    const b1 = await prisma.build.findFirst({ where: { productId, itemKey: "E1.S1.T1" } });
    const dup = await startBuild({ companyId: ws, productId, itemKey: "E1.S1.T1", actor: "x", maxRepairs: 1 });
    expect(dup.id).toBe(b1!.id);
    expect(await prisma.build.count({ where: { productId } })).toBe(before);
    // A finished run delivered again by the queue returns without executing anything.
    await prisma.build.update({ where: { id: b1!.id }, data: { status: "FAILED" } });
    const cmds = await prisma.commandRun.count({ where: { buildId: b1!.id } });
    expect(await runBuild(b1!.id, null)).toEqual({ status: "FAILED" });
    expect(await prisma.commandRun.count({ where: { buildId: b1!.id } })).toBe(cmds);
    await prisma.build.update({ where: { id: b1!.id }, data: { status: "QUEUED" } });
  });

  it("17: cancellation propagates to the queued job and the run; nothing further executes", async () => {
    const b2 = (await prisma.build.findFirst({ where: { productId, itemKey: "E1.S1.T2" } }))!;
    const r = await cancelBuild(ws, b2.id);
    expect(r.status).toBe("CANCELLED");
    expect((await prisma.job.findUnique({ where: { id: b2.jobId! } }))!.status).toBe("CANCELLED");
    expect(await runBuild(b2.id, b2.jobId)).toEqual({ status: "CANCELLED" });
    await tickProduct(ws, productId);
    expect((await items()).find((i) => i.key === "E1.S1.T2")!.status).toBe("FAILED"); // settled as cancelled, never verified
  });

  it("11: a run orphaned by a crashed worker is recovered to BLOCKED with the reason, never left running", async () => {
    const b1 = (await prisma.build.findFirst({ where: { productId, itemKey: "E1.S1.T1" } }))!;
    await prisma.build.update({ where: { id: b1.id }, data: { status: "RUNNING", phase: "verify" } });
    await prisma.job.update({ where: { id: b1.jobId! }, data: { status: "DEAD", lastError: "worker crashed" } });
    expect(await recoverOrphanedBuilds(ws, productId)).toEqual([b1.id]);
    const after = (await prisma.build.findUnique({ where: { id: b1.id } }))!;
    expect(after.status).toBe("BLOCKED");
    expect(after.failure).toMatch(/Recovered after an interruption.*dead.*worker crashed/s);
    await tickProduct(ws, productId);
    expect((await items()).find((i) => i.key === "E1.S1.T1")!.status).toBe("BLOCKED");
  });

  it("6: a changed requirement reopens the work that implemented it, cancels in-flight runs and stales memory", async () => {
    // Setup: T1 verified by an engine actor (as a successful run would), T4 running.
    const t1 = (await prisma.backlogItem.findFirst({ where: { productId, key: "E1.S1.T1" } }))!;
    await setItemStatus(t1, "READY", { kind: "engine", id: "test" }, "setup");
    const t1r = (await prisma.backlogItem.findFirst({ where: { productId, key: "E1.S1.T1" } }))!;
    await setItemStatus(t1r, "IN_PROGRESS", { kind: "engine", id: "test" }, "setup");
    const t1p = (await prisma.backlogItem.findFirst({ where: { productId, key: "E1.S1.T1" } }))!;
    await setItemStatus(t1p, "VERIFIED", { kind: "engine", id: "test" }, "setup", {}, { verified: true });
    await prisma.projectMemory.create({ data: { companyId: ws, productId, key: "api:POST /api/assessments", kind: "api_contract", content: "POST /api/assessments scores a listing", status: "VERIFIED", requirements: JSON.stringify(["FR-1"]), provenance: "{}" } });
    const latest = await prisma.productBrief.findFirst({ where: { productId }, orderBy: { version: "desc" } });
    const next = { ...V3_BRIEF, functional: [{ id: "FR-1", text: "Users can submit a job listing or URL and get a risk assessment with reasons" }, V3_BRIEF.functional[1]] };
    const r = await reviseBrief(ws, productId, users.owner.email, next, latest!.version, "URLs too");
    expect(r.requirements.changed).toEqual(["FR-1"]);
    expect(r.reopened).toEqual(expect.arrayContaining(["E1.S1.T1"]));
    expect(r.affected).not.toContain("E1.S1.T2"); // FR-2 work is untouched
    const st = Object.fromEntries((await items()).map((i) => [i.key, i.status]));
    expect(st["E1.S1.T1"]).toBe("READY");
    expect(st["E1.S1.T2"]).toBe("FAILED");
    expect((await listMemory(ws, productId)).find((m) => m.key === "api:POST /api/assessments")!.status).toBe("STALE");
    const cs = await prisma.productArtifact.findFirst({ where: { productId, kind: "CHANGE_SET" } });
    expect(JSON.parse(cs!.content)).toMatchObject({ briefFrom: latest!.version, briefTo: latest!.version + 1 });
    expect((await prisma.product.findUnique({ where: { id: productId } }))!.scopeApproved).toBe(false); // needs re-approval
  });

  it("18: the product budget stops new dispatch and raises a usage alert", async () => {
    const scope = (await productDetail(ws, productId)).approvals.find((a) => a.action === "scope" && a.status === "PENDING")!;
    await decideProductApproval(ws, productId, scope.id, users.owner.email, "approve");
    await prisma.product.update({ where: { id: productId }, data: { limits: JSON.stringify({ maxParallel: 3, projectBudgetUsd: 0.5 }) } });
    await prisma.build.updateMany({ where: { productId }, data: { costUsd: 0.3, status: "CANCELLED" } });
    const t = await tickProduct(ws, productId);
    expect(t.dispatched).toEqual([]);
    expect(t.waitingOn.some((w) => /product budget reached/.test(w))).toBe(true);
    expect(await prisma.notification.findFirst({ where: { companyId: ws, dedupeKey: `product-budget:${productId}:exhausted` } })).not.toBeNull();
  });
});

describe("V3: quality gate, delivery report, rollback, authorization", () => {
  it("15 + 20: the gate refuses premature completion and the delivery report matches the records", async () => {
    const g = await evaluateGate(ws, productId);
    expect(g.implemented).toBe(false);
    expect(g.approvedForRelease).toBe(false);
    expect(g.summary.requiredOpen).toEqual(expect.arrayContaining(["requirements", "tasks", "integration"]));
    expect(g.criteria.find((c) => c.id === "journeys")).toMatchObject({ status: "not_verified" });
    expect(g.criteria.find((c) => c.id === "requirements")!.detail).toMatch(/not yet verified/);
    const rep = await deliveryReport(ws, productId, users.owner.email);
    expect(rep.conclusion).toMatchObject({ implemented: false, deployed: false });
    const ops = await prisma.gitOperation.findMany({ where: { productId, status: "SUCCEEDED", op: { in: ["commit", "branch", "pull_request", "rollback"] } } });
    expect(rep.commits).toHaveLength(ops.length);
    expect(rep.defects.total).toBe(await prisma.defect.count({ where: { productId } }));
    expect(rep.tasks.map((t) => t.key).sort()).toEqual((await prisma.backlogItem.findMany({ where: { productId, level: { in: ["TASK", "REPAIR"] } } })).map((i) => i.key).sort());
    const art = await prisma.productArtifact.findUnique({ where: { id: rep.id } });
    expect(art!.kind).toBe("DELIVERY_REPORT");
    expect(art!.status).toBe("PROPOSED"); // incomplete reports are never "approved"
  });

  it("13: rollback reverts only AURA's commits on the task branch; a person's commit on that branch is preserved", async () => {
    const p = (await prisma.product.findUnique({ where: { id: productId } }))!;
    // AURA commits a change on the task branch (as a verified run would) …
    await commitFiles({ companyId: ws, repoId: p.repoId!, base: "main", branch: "aura/e1.s1.t2", files: { "src/history.js": "module.exports = { list: () => [] };\n" }, message: "E1.S1.T2: History store" });
    // … then a person adds their own commit to the same branch.
    const wt = mkdtempSync(join(tmpdir(), "aura-v3-user-"));
    roots.push(wt);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const g = (...a: string[]) => execFileSync("git", a, { cwd: wt, env, encoding: "utf8" });
    g("clone", "--quiet", bareDir(ws, p.repoId!), ".");
    g("checkout", "--quiet", "aura/e1.s1.t2");
    writeFileSync(join(wt, "NOTES.md"), "my notes\n");
    g("add", "NOTES.md");
    g("-c", "user.name=Dana", "-c", "user.email=dana@example.com", "commit", "--quiet", "-m", "my notes");
    g("push", "--quiet", "origin", "aura/e1.s1.t2");
    const r = await rollbackItem(ws, productId, "E1.S1.T2", users.owner.email, "wrong approach");
    expect(r.status).toBe("REVERTED");
    expect(r.reverted).toHaveLength(1);
    expect(r.kept).toHaveLength(1);
    expect(await readAt(ws, p.repoId!, "aura/e1.s1.t2", "src/history.js")).toBeNull();
    expect(await readAt(ws, p.repoId!, "aura/e1.s1.t2", "NOTES.md")).toBe("my notes");
    expect(await readAt(ws, p.repoId!, "main", "README.md")).not.toBeNull(); // default branch untouched
    // The task is reopened: its earlier verification no longer describes the branch.
    expect((await items()).find((i) => i.key === "E1.S1.T2")!.status).toBe("READY");
    expect((await prisma.gitOperation.findFirst({ where: { productId, op: "rollback" } }))!.detail).toMatch(/reverted 1 AURA commit.*kept 1/);
  }, 60_000);

  it("16: sensitive operations need the configured role; other workspaces see nothing", async () => {
    await as("viewer");
    expect((await RollbackRoute.POST(req("POST", {}), ctx({ id: ws, productId, key: "E1.S1.T1" }))).status).toBe(403);
    expect((await GateRoute.POST(req("POST", { action: "report" }), ctx({ id: ws, productId }))).status).toBe(403);
    expect((await GateRoute.GET(req(), ctx({ id: ws, productId }))).status).toBe(200);
    expect((await DefectsRoute.GET(req(), ctx({ id: ws, productId }))).status).toBe(200);
    await as("member");
    expect((await GateRoute.PATCH(req("PATCH", { profile: "static-site" }), ctx({ id: ws, productId }))).status).toBe(403);
    const mem = (await listMemory(ws, productId))[0];
    expect((await MemoryRoute.PATCH(req("PATCH", { memoryId: mem.id, status: "VERIFIED" }), ctx({ id: ws, productId }))).status).toBe(403);
    expect((await MemoryRoute.PATCH(req("PATCH", { memoryId: mem.id, status: "INVALIDATED", note: "wrong" }), ctx({ id: ws, productId }))).status).toBe(200);
    await as("owner");
    const pr = await GateRoute.PATCH(req("PATCH", { profile: "financial" }), ctx({ id: ws, productId }));
    expect(pr.status).toBe(200);
    const gate = (await (await GateRoute.GET(req(), ctx({ id: ws, productId }))).json()) as { data: { profile: string; criteria: { id: string; required: boolean }[] } };
    expect(gate.data.profile).toBe("financial");
    expect(gate.data.criteria.find((c) => c.id === "journeys")!.required).toBe(true);
    const intel = (await (await IntelRoute.GET(req("GET", undefined, "http://t.local/x?item=E1.S1.T1"), ctx({ id: ws, productId }))).json()) as { data: { parser: string; routes: { path: string }[]; item: { key: string } } };
    expect(intel.data.parser).toBe("typescript");
    expect(intel.data.routes.some((r) => r.path === "/api/health")).toBe(true);
    expect(intel.data.item.key).toBe("E1.S1.T1");
    await as("outsider");
    for (const r of [await GateRoute.GET(req(), ctx({ id: ws, productId })), await MemoryRoute.GET(req(), ctx({ id: ws, productId })), await DefectsRoute.GET(req(), ctx({ id: ws, productId }))]) expect([403, 404]).toContain(r.status);
    expect((await GateRoute.GET(req(), ctx({ id: otherWs, productId }))).status).toBe(404);
    await as(null);
  });
});
