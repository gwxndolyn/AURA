/**
 * V7 customer journey, end to end, on REAL infrastructure:
 *   real DB · job queue + worker · git · builder in the Docker sandbox ·
 *   release integration re-tested in Docker · REAL deployment as a Docker
 *   container (provider `docker-host`) · HTTP verification of the deployed
 *   app · automatic rollback of a failing release · follow-up change request
 *   on the existing code · redeploy with the original feature preserved.
 *
 * TEST DOUBLE: only the model provider's HTTP endpoint (scripted answers;
 * every tool call it makes is really executed). Not proof of live model
 * quality. The deployment target is the local Docker daemon — a real
 * deployment of a real container, but not a managed cloud provider.
 * Skipped (not faked) without Docker.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
import { startAnthropicDouble, type Double } from "../../../test/doubles/anthropic";
import { scripted } from "../../../test/doubles/scamscout";
import { changeScripted, CHANGE_REQUEST } from "../../../test/doubles/scamscout-change";
import { drain } from "@/lib/jobs/worker";
import { createProduct } from "@/lib/factory/store";
import { productDetail } from "@/lib/factory/read";
import { tickProduct } from "@/lib/factory/scheduler";
import { decideProductApproval, createReleaseCandidate } from "@/lib/factory/release";
import { evaluateGate } from "@/lib/factory/gate";
import { deliveryScorecard } from "@/lib/factory/scorecard";
import { readAt } from "@/lib/factory/git";
import { submitChangeRequest } from "@/lib/factory/change";
import { upsertTarget, requestProductDeploy } from "./service";
import * as DeployRoute from "@/app/api/companies/[id]/products/[productId]/deploy/route";
import * as ApprovalRoute from "@/app/api/companies/[id]/products/[productId]/approvals/[approvalId]/route";

let docker = false;
try {
  execFileSync("docker", ["image", "inspect", "node:20-alpine"], { stdio: "ignore", timeout: 8000 });
  docker = true;
} catch {
  docker = false;
}

const users: Record<string, { id: string; email: string }> = {};
let ws: string, other: string, double: Double, productId = "";
const roots: string[] = [];
const PORT = 21000 + Math.floor(Math.random() * 1000); // unlikely to clash with local services
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const req = (method = "GET", body?: unknown) => new Request("http://t.local/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const as = async (n: string | null) => { currentToken = n ? await createSessionToken({ userId: users[n].id, email: users[n].email }) : null; };
async function until(fn: () => Promise<boolean>, max = 80) {
  for (let i = 0; i < max && !(await fn()); i++) if (!(await drain(1, [ws]))) await new Promise((r) => setTimeout(r, 150));
}
const tickUntilSettled = async () => {
  for (let i = 0; i < 25; i++) {
    await tickProduct(ws, productId);
    await until(async () => !(await prisma.build.count({ where: { productId, status: { in: ["QUEUED", "RUNNING"] } } })), 120);
    const d = await productDetail(ws, productId);
    if (d.items.filter((x) => (x.level === "TASK" || x.level === "REPAIR") && x.executable && x.status !== "CANCELLED").every((x) => ["VERIFIED", "FAILED", "BLOCKED"].includes(x.status))) return d;
  }
  return productDetail(ws, productId);
};
const approveAll = async (action: string) => {
  const d = await productDetail(ws, productId);
  for (const a of d.approvals.filter((x) => x.action === action && x.status === "PENDING")) await decideProductApproval(ws, productId, a.id, users.owner.email, "approve");
};

describe.skipIf(!docker)("V7 customer journey: idea → verified build → real deployment → rollback → follow-up change", () => {
  beforeAll(async () => {
    for (const k of ["AURA_GIT_ROOT", "AURA_WORK_ROOT"]) { const d = mkdtempSync(join(tmpdir(), `aura-v7-${k.toLowerCase()}-`)); roots.push(d); process.env[k] = d; }
    double = await startAnthropicDouble(changeScripted(scripted({ fixOnRepair: true })) as never);
    process.env.ANTHROPIC_API_KEY = "test-key-for-double";
    process.env.ANTHROPIC_BASE_URL = double.url;
    resetClientForTests();
    const s = Date.now();
    for (const n of ["owner", "member", "outsider"]) users[n] = await prisma.user.create({ data: { email: `${n}_${s}@v7.local`, name: n } });
    ws = (await createCompany({ name: "V7", mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
    other = (await createCompany({ name: "V7-O", mission: "m", industry: "SaaS", ownerId: users.outsider.id })).id;
    await prisma.workspaceMember.create({ data: { userId: users.member.id, companyId: ws, role: "MEMBER" } });
    await prisma.subscription.create({ data: { companyId: ws, plan: "pro", status: "active" } });
  }, 60_000);

  afterAll(async () => {
    try { execFileSync("sh", ["-c", `docker ps -aq --filter label=aura.product=${productId} | xargs -r docker rm -f`], { stdio: "ignore" }); } catch { /* best effort */ }
    await double.close();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    resetClientForTests();
    await prisma.company.deleteMany({ where: { id: { in: [ws, other] } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
    await prisma.$disconnect();
    for (const d of roots) rmSync(d, { recursive: true, force: true });
  });

  it("1–8: idea → persisted brief + plan → build with a real failing test, repair, re-verification → code inspectable", async () => {
    const r = await createProduct({ companyId: ws, userId: users.owner.id, actor: users.owner.email, idea: "Build me a job scam detection platform where users can submit suspicious job listings and get a risk assessment.", autonomy: "BOUNDED" });
    productId = r.product.id;
    await until(async () => (await prisma.product.findUnique({ where: { id: productId } }))!.planningStatus === "READY");
    let d = await productDetail(ws, productId);
    expect(d.brief?.source).toBe("model");
    expect(d.items.find((i) => i.key === "E1.S1.T1")!.acceptance).toHaveLength(3);
    await approveAll("scope");
    d = await tickUntilSettled();
    expect(d.items.find((i) => i.key === "E1.S1.T1")!.status).toBe("VERIFIED");
    const build = await prisma.build.findFirst({ where: { productId, status: "VERIFIED" }, include: { commands: true } });
    const tests = build!.commands.filter((c) => c.actor === "engine" && c.purpose === "test");
    expect(tests[0].exitCode).not.toBe(0); // the deliberately buggy first attempt really failed
    expect(tests[tests.length - 1].exitCode).toBe(0);
    expect(await prisma.defect.findFirst({ where: { buildId: build!.id, status: "FIXED" } })).not.toBeNull();
    expect(await readAt(ws, d.repo!.id, build!.branch, "src/routes/assessments.js")).toMatch(/toLowerCase/);
  }, 600_000);

  it("9–10: release candidate re-tested → preflight → approval (ADMIN only) → REAL container deployment → HTTP verification", async () => {
    const rc = await createReleaseCandidate(ws, productId, users.owner.email);
    expect(rc.test?.failed).toBe(0);
    await approveAll("release_candidate");
    await as("member");
    expect((await DeployRoute.POST(req("POST", { action: "target", env: "production", provider: "docker-host", config: { port: PORT } }), ctx({ id: ws, productId }))).status).toBe(403);
    await as(null);
    const t = await upsertTarget({ companyId: ws, productId, env: "production", provider: "docker-host", config: { port: PORT, healthPath: "/api/health", journeys: [{ path: "/", expectText: "<html" }, { path: "/api/assessments", expectStatus: 200 }] }, secretEnvNames: [], autoDeploy: false, actor: users.owner.email });
    expect(t.status).toBe("CONNECTED");
    await expect(upsertTarget({ companyId: ws, productId, env: "production", provider: "docker-host", config: {}, secretEnvNames: ["ANTHROPIC_API_KEY"], autoDeploy: false, actor: "x" })).rejects.toThrow(/never shared/);
    const { deployment, approval } = await requestProductDeploy(ws, productId, "production", users.member.email);
    expect(deployment.status).toBe("PREFLIGHT");
    expect(approval).not.toBeNull();
    // Nothing runs before approval; a MEMBER cannot approve production.
    await drain(5, [ws]);
    expect((await prisma.productDeployment.findUnique({ where: { id: deployment.id } }))!.status).toBe("PREFLIGHT");
    await as("member");
    expect((await ApprovalRoute.POST(req("POST", { decision: "approve" }), ctx({ id: ws, productId, approvalId: approval!.id }))).status).toBe(403);
    await as("owner");
    expect((await ApprovalRoute.POST(req("POST", { decision: "approve" }), ctx({ id: ws, productId, approvalId: approval!.id }))).status).toBe(200);
    await as(null);
    await until(async () => ["VERIFIED", "FAILED", "ROLLED_BACK"].includes((await prisma.productDeployment.findUnique({ where: { id: deployment.id } }))!.status), 200);
    const dep = (await prisma.productDeployment.findUnique({ where: { id: deployment.id } }))!;
    if (dep.status !== "VERIFIED") console.log(dep.status, dep.failure, dep.logs.slice(-2000));
    expect(dep.status).toBe("VERIFIED");
    expect(dep.url).toBe(`http://127.0.0.1:${PORT}`);
    expect(JSON.parse(dep.providerRef).container).toMatch(/^[0-9a-f]{12,}/);
    // Independently hit the deployed application.
    const created = await (await fetch(`${dep.url}/api/assessments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ listing: "UPFRONT PAYMENT required" }) })).json();
    expect(created.level).toBe("high");
    // The release engineer's tool call is audited and carried the approval.
    expect(await prisma.auditLog.findFirst({ where: { companyId: ws, action: "TOOL_CALL", target: "deploy.run" } })).not.toBeNull();
    const gate = await evaluateGate(ws, productId);
    expect(gate.deployed).toBe(true);
    expect(gate.criteria.find((c) => c.id === "journeys")!.status).toBe("passed");
  }, 600_000);

  it("rollback: a release whose deployed app fails its health check is stopped and the previous version is restored", async () => {
    const good = (await prisma.productDeployment.findFirst({ where: { productId, status: "VERIFIED" } }))!;
    // Point the target at a health path the app does not serve: the new deployment must fail verification.
    await upsertTarget({ companyId: ws, productId, env: "production", provider: "docker-host", config: { port: PORT, healthPath: "/api/not-there", journeys: [{ path: "/" }] }, secretEnvNames: [], autoDeploy: false, actor: users.owner.email });
    const { deployment, approval } = await requestProductDeploy(ws, productId, "production", users.owner.email);
    await decideProductApproval(ws, productId, approval!.id, users.owner.email, "approve");
    await until(async () => ["VERIFIED", "FAILED", "ROLLED_BACK"].includes((await prisma.productDeployment.findUnique({ where: { id: deployment.id } }))!.status), 200);
    const bad = (await prisma.productDeployment.findUnique({ where: { id: deployment.id } }))!;
    expect(bad.status).toBe("ROLLED_BACK");
    expect(bad.rolledBackTo).toBe(good.id);
    expect(bad.logs).toMatch(/verification FAILED/);
    // The previous version is serving again, and is still recorded as the verified live version.
    const h = await fetch(`${good.url}/api/health`);
    expect(h.status).toBe(200);
    expect((await prisma.productDeployment.findUnique({ where: { id: good.id } }))!.status).toBe("VERIFIED");
    await upsertTarget({ companyId: ws, productId, env: "production", provider: "docker-host", config: { port: PORT, healthPath: "/api/health", journeys: [{ path: "/", expectText: "<html" }, { path: "/api/assessments", expectStatus: 200 }] }, secretEnvNames: [], autoDeploy: false, actor: users.owner.email });
  }, 600_000);

  it("11–12: a follow-up change is planned as a targeted task on the existing code, verified, released and redeployed; the original feature still works", async () => {
    const before = await prisma.backlogItem.count({ where: { productId } });
    await submitChangeRequest(ws, productId, CHANGE_REQUEST, users.owner.email);
    await until(async () => !!(await prisma.backlogItem.findFirst({ where: { productId, key: "C1.T1" } })));
    const t = (await prisma.backlogItem.findFirst({ where: { productId, key: "C1.T1" } }))!;
    expect(JSON.parse(t.files)).toContain("src/routes/assessments.js");
    expect(await prisma.backlogItem.count({ where: { productId } })).toBe(before + 2); // one story + one task, nothing regenerated
    expect((await prisma.backlogItem.findFirst({ where: { productId, key: "E1.S1.T1" } }))!.status).toBe("VERIFIED"); // existing work untouched
    await approveAll("scope");
    const d = await tickUntilSettled();
    if (d.items.find((i) => i.key === "C1.T1")!.status !== "VERIFIED") {
      const b = await prisma.build.findFirst({ where: { productId, itemKey: "C1.T1" }, include: { commands: true }, orderBy: { createdAt: "desc" } });
      console.log("C1.T1", d.items.find((i) => i.key === "C1.T1")!.status, b?.status, b?.stopReason, b?.failure.slice(0, 1500), b?.findings.slice(0, 1500));
      for (const c of b?.commands ?? []) console.log("CMD", c.actor, c.purpose, c.command, c.exitCode, c.output.slice(-600));
    }
    expect(d.items.find((i) => i.key === "C1.T1")!.status).toBe("VERIFIED");
    const cb = await prisma.build.findFirst({ where: { productId, itemKey: "C1.T1", status: "VERIFIED" }, include: { commands: true } });
    const full = cb!.commands.filter((c) => c.actor === "engine" && c.purpose === "test").pop()!;
    expect(full.output).toMatch(/upfront payment is high risk/); // the original tests ran again and passed (regression)
    expect(full.exitCode).toBe(0);
    const rc2 = await createReleaseCandidate(ws, productId, users.owner.email);
    expect(rc2.test?.failed).toBe(0);
    await approveAll("release_candidate");
    const { deployment, approval } = await requestProductDeploy(ws, productId, "production", users.owner.email);
    await decideProductApproval(ws, productId, approval!.id, users.owner.email, "approve");
    await until(async () => ["VERIFIED", "FAILED", "ROLLED_BACK"].includes((await prisma.productDeployment.findUnique({ where: { id: deployment.id } }))!.status), 200);
    const dep = (await prisma.productDeployment.findUnique({ where: { id: deployment.id } }))!;
    if (dep.status !== "VERIFIED") console.log("REDEPLOY", dep.status, dep.failure, dep.logs.slice(-3000));
    expect(dep.status).toBe("VERIFIED");
    const created = await (await fetch(`${dep.url}/api/assessments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ listing: "Wire Transfer and upfront payment" }) })).json();
    expect(created.level).toBe("high"); // original feature preserved
    const one = await fetch(`${dep.url}/api/assessments/${created.id}`);
    expect(one.status).toBe(200); // new feature live
    const nope = await fetch(`${dep.url}/api/assessments/nope`);
    expect(nope.status).toBe(404);
    const sc = await deliveryScorecard(ws, productId);
    expect(sc.metrics.deployVerification.value).toBeCloseTo(2 / 3); // 2 verified of 3 that reached verification (one rolled back)
    expect(sc.metrics.buildSuccessRate.denominator).toBeGreaterThan(0);
    expect(sc.metrics.requirementsSatisfied.value).toBe(1);
    expect(sc.metrics.timeToFirstUsableMin.value).toBeGreaterThan(0);
    await as("outsider");
    expect([403, 404]).toContain((await DeployRoute.GET(req(), ctx({ id: ws, productId }))).status);
    expect((await DeployRoute.GET(req(), ctx({ id: other, productId }))).status).toBe(404);
    await as(null);
  }, 900_000);
});
