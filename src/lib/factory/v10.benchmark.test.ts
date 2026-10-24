/**
 * AURA V10 end-to-end benchmark, on the REAL pipeline:
 *   createProduct → planning job (PM, validated) → scope approval → scheduler
 *   → builder (engineer tool use executed for real; npm test in the Docker
 *   sandbox; app rendered in real Chromium; risk-planned QA/security/review)
 *   → dependent task built ON its verified dependency → browser-found defect
 *   → category-specific repair → VERIFIED → release candidate re-tested →
 *   real container deployment → HTTP checks + persistence across a RESTART
 *   → follow-up change request (targeted) → re-verified, existing tests pass.
 *
 * TEST DOUBLE: the model provider only (test/doubles/expenses.ts). Nothing
 * else is simulated. Skipped — not faked — without Docker + Chromium.
 *
 * The benchmark FAILS when a critical acceptance criterion is not met; the
 * criteria are fixed below and never relaxed to make a run pass.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {} }) }));

import { prisma } from "@/lib/db";
import { createCompany } from "@/lib/company/provision";
import { resetClientForTests } from "@/lib/ai/claude";
import { drain } from "@/lib/jobs/worker";
import { createProduct } from "./store";
import { productDetail } from "./read";
import { tickProduct } from "./scheduler";
import { decideProductApproval, createReleaseCandidate } from "./release";
import { evaluateGate } from "./gate";
import { deliveryScorecard } from "./scorecard";
import { submitChangeRequest } from "./change";
import { readAt } from "./git";
import { upsertTarget, requestProductDeploy } from "@/lib/deploy/service";
import { browserAvailable } from "@/lib/builder/browser";
import { PROMPT_LIBRARY_VERSION } from "@/lib/agents/prompts";
import { processPending } from "@/lib/learning/service";
import { intelligenceOverview } from "@/lib/learning/workspace";
import { startAnthropicDouble, type Double } from "../../../test/doubles/anthropic";
import { expensesScripted, REQUEST, CHANGE_REQUEST } from "../../../test/doubles/expenses";

let ready = false;
try {
  execFileSync("docker", ["image", "inspect", "node:20-alpine"], { stdio: "ignore", timeout: 8000 });
  ready = true;
} catch {
  ready = false;
}

const users: Record<string, { id: string; email: string }> = {};
let ws = "", productId = "", double: Double;
const model = expensesScripted();
const roots: string[] = [];
const PORT = 25000 + Math.floor(Math.random() * 1000);
const report: Record<string, unknown> = { request: REQUEST, promptLibrary: PROMPT_LIBRARY_VERSION };

async function until(fn: () => Promise<boolean>, max = 120) {
  for (let i = 0; i < max && !(await fn()); i++) if (!(await drain(1, [ws]))) await new Promise((r) => setTimeout(r, 150));
}
const settle = async () => {
  for (let i = 0; i < 30; i++) {
    await tickProduct(ws, productId);
    await until(async () => !(await prisma.build.count({ where: { productId, status: { in: ["QUEUED", "RUNNING"] } } })), 300);
    const d = await productDetail(ws, productId);
    if (d.items.filter((x) => (x.level === "TASK" || x.level === "REPAIR") && x.executable && x.status !== "CANCELLED").every((x) => ["VERIFIED", "FAILED", "BLOCKED"].includes(x.status))) return d;
  }
  return productDetail(ws, productId);
};
const approveAll = async (action: string) => {
  const d = await productDetail(ws, productId);
  for (const a of d.approvals.filter((x) => x.action === action && x.status === "PENDING")) await decideProductApproval(ws, productId, a.id, users.owner.email, "approve");
};

describe.skipIf(!ready)("V10 benchmark: responsive expense tracker through the real AURA pipeline", () => {
  beforeAll(async () => {
    const b = await browserAvailable();
    if (!b.ok) throw new Error(`benchmark needs browser automation: ${b.reason}`);
    for (const k of ["AURA_GIT_ROOT", "AURA_WORK_ROOT", "AURA_EVIDENCE_ROOT"]) { const d = mkdtempSync(join(tmpdir(), `aura-v10-${k.toLowerCase()}-`)); roots.push(d); process.env[k] = d; }
    double = await startAnthropicDouble(model.respond as never);
    process.env.ANTHROPIC_API_KEY = "test-key-for-double";
    process.env.ANTHROPIC_BASE_URL = double.url;
    resetClientForTests();
    const s = Date.now();
    users.owner = await prisma.user.create({ data: { email: `v10_${s}@bench.local`, name: "owner" } });
    ws = (await createCompany({ name: "V10", mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
    await prisma.subscription.create({ data: { companyId: ws, plan: "team", status: "active" } });
  }, 60_000);

  afterAll(async () => {
    writeFileSync(join(tmpdir(), "aura-v10-benchmark.json"), JSON.stringify(report, null, 2));
    try { execFileSync("sh", ["-c", `docker ps -aq --filter label=aura.product=${productId} | xargs -r docker rm -f`], { stdio: "ignore" }); } catch { /* best effort */ }
    await double?.close();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    resetClientForTests();
    await prisma.company.deleteMany({ where: { id: ws } });
    await prisma.user.deleteMany({ where: { id: users.owner?.id } });
    for (const d of roots) rmSync(d, { recursive: true, force: true });
  });

  it("plans with a core journey, constraints and testable criteria (PM)", async () => {
    const r = await createProduct({ companyId: ws, userId: users.owner.id, actor: users.owner.email, idea: REQUEST, autonomy: "BOUNDED", limits: { maxRepairs: 2 } });
    productId = r.product.id;
    await until(async () => (await prisma.product.findUnique({ where: { id: productId } }))!.planningStatus === "READY");
    const d = await productDetail(ws, productId);
    const brief = d.brief!.content as Record<string, unknown>;
    expect(brief.coreJourney).toBeTruthy();
    expect(brief.constraints).toEqual(expect.arrayContaining(["Persistent storage", "Category filtering"]));
    expect(d.items.filter((i) => i.level === "TASK").map((i) => i.key)).toEqual(["E1.S1.T1", "E1.S1.T2"]);
    const pm = await prisma.agentRun.findMany({ where: { companyId: ws, agent: { key: "product-manager" } } });
    expect(pm.length).toBeGreaterThanOrEqual(2);
    expect(pm.every((r) => r.promptRef.endsWith(`@${PROMPT_LIBRARY_VERSION}`) && r.status === "COMPLETED")).toBe(true);
    report.plan = { brief: { title: brief.title, coreJourney: brief.coreJourney }, tasks: d.items.filter((i) => i.level === "TASK").map((i) => ({ key: i.key, kind: i.kind, acceptance: i.acceptance })), pmRuns: pm.map((r) => r.promptRef) };
  }, 120_000);

  it("builds backend then frontend; the browser finds real UI defects; a bounded repair fixes them", async () => {
    await approveAll("scope");
    const d = await settle();
    const t1 = d.items.find((i) => i.key === "E1.S1.T1")!;
    const t2 = d.items.find((i) => i.key === "E1.S1.T2")!;
    const b1 = (await prisma.build.findFirst({ where: { productId, itemKey: "E1.S1.T1" }, orderBy: { createdAt: "desc" } }))!;
    const b2 = (await prisma.build.findFirst({ where: { productId, itemKey: "E1.S1.T2" }, orderBy: { createdAt: "desc" }, include: { commands: true } }))!;
    report.builds = [b1, b2].map((b) => ({ item: b.itemKey, status: b.status, attempts: b.attempt + 1, orchestration: JSON.parse(b.orchestration), browser: (({ routes, ...r }) => ({ ...r, routes: (routes ?? []).map((x: { route: string; viewport: string; httpStatus: number }) => `${x.route}@${x.viewport}:${x.httpStatus}`) }))(JSON.parse(b.browser || "{}")), context: JSON.parse(b.contextManifest), findings: JSON.parse(b.findings).map((f: { source: string; title: string; blocking: boolean }) => `${f.source}${f.blocking ? "!" : ""}: ${f.title}`) }));
    if (t2.status !== "VERIFIED") console.log(JSON.stringify(report.builds, null, 2), b2.failure);
    expect(t1.status).toBe("VERIFIED");
    expect(t2.status).toBe("VERIFIED");
    // Backend: medium risk → QA + security + review (risk-planned), all executed.
    expect(JSON.parse(b1.orchestration).reviewers).toEqual(["qa-engineer", "security-engineer", "reviewer"]);
    // Frontend: first attempt failed in the BROWSER (tests passed), repaired with the browser evidence.
    const o2 = JSON.parse(b2.orchestration);
    expect(o2.attempts[0].passed).toBe(true); // unit tests passed on attempt 1 …
    expect(o2.attempts[0].blocking).toBeGreaterThan(0); // … yet blocking browser findings stopped it
    expect(b2.attempt).toBeGreaterThanOrEqual(1);
    const browser = JSON.parse(b2.browser);
    expect(browser.status).toBe("passed");
    expect(browser.routes.map((r: { viewport: string }) => r.viewport).sort()).toEqual(["desktop", "mobile"]);
    expect(browser.journeys).toEqual([expect.objectContaining({ name: "create → reload → persists", status: "passed" })]);
    // The frontend run was built ON the verified API (dependency merged), and saw the API contract in context.
    expect(await readAt(ws, d.repo!.id, b2.branch, "src/routes/expenses.js")).toMatch(/summary/);
    expect(JSON.parse(b2.contextManifest).map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(["task", "repo", "relevant"]));
    // Evidence: real tests ran in the sandbox.
    expect(b2.commands.filter((c) => c.actor === "engine" && c.purpose === "test").pop()!.exitCode).toBe(0);
  }, 900_000);

  it("releases, deploys a real container, verifies monthly totals, filtering, validation and persistence across a restart", async () => {
    const rc = await createReleaseCandidate(ws, productId, users.owner.email);
    expect(rc.test?.failed).toBe(0);
    await approveAll("release_candidate");
    await upsertTarget({ companyId: ws, productId, env: "production", provider: "docker-host", config: { port: PORT, healthPath: "/api/health", journeys: [{ path: "/", expectText: "Pocket Ledger" }, { path: "/api/expenses", expectStatus: 200 }] }, secretEnvNames: [], autoDeploy: false, actor: users.owner.email });
    const { deployment, approval } = await requestProductDeploy(ws, productId, "production", users.owner.email);
    await decideProductApproval(ws, productId, approval!.id, users.owner.email, "approve");
    await until(async () => ["VERIFIED", "FAILED", "ROLLED_BACK"].includes((await prisma.productDeployment.findUnique({ where: { id: deployment.id } }))!.status), 300);
    const dep = (await prisma.productDeployment.findUnique({ where: { id: deployment.id } }))!;
    if (dep.status !== "VERIFIED") console.log(dep.failure, dep.logs.slice(-2000));
    expect(dep.status).toBe("VERIFIED");
    const url = dep.url!;
    const post = (b: unknown) => fetch(`${url}/api/expenses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const month = new Date().toISOString().slice(0, 7);
    expect((await post({ description: "bad", amount: -1, category: "food", date: `${month}-01` })).status).toBe(400);
    await post({ description: "Lunch", amount: 12.3, category: "food", date: `${month}-02` });
    await post({ description: "Bus", amount: 2.7, category: "transport", date: `${month}-03` });
    const s1 = await (await fetch(`${url}/api/expenses/summary?month=${month}`)).json();
    expect(s1.totalCents).toBe(1500);
    expect((await (await fetch(`${url}/api/expenses?category=transport`)).json()).map((e: { description: string }) => e.description)).toEqual(["Bus"]);
    // Persistence across a PROCESS RESTART of the deployed container.
    const container = JSON.parse(dep.providerRef).name as string;
    execFileSync("docker", ["restart", container], { timeout: 60_000 });
    let s2: { totalCents?: number } = {};
    for (let i = 0; i < 40; i++) {
      try { s2 = await (await fetch(`${url}/api/expenses/summary?month=${month}`)).json(); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    expect(s2.totalCents).toBe(1500);
    report.deployment = { url, status: dep.status, totalAfterRestart: s2.totalCents };
  }, 900_000);

  it("a follow-up change is targeted, verified, and keeps existing behaviour", async () => {
    const before = await prisma.backlogItem.count({ where: { productId } });
    await submitChangeRequest(ws, productId, CHANGE_REQUEST, users.owner.email);
    await until(async () => !!(await prisma.backlogItem.findFirst({ where: { productId, key: "C1.T1" } })));
    expect(await prisma.backlogItem.count({ where: { productId } })).toBe(before + 2);
    await approveAll("scope");
    const d = await settle();
    const c = d.items.find((i) => i.key === "C1.T1")!;
    const cb = (await prisma.build.findFirst({ where: { productId, itemKey: "C1.T1" }, orderBy: { createdAt: "desc" }, include: { commands: true } }))!;
    if (c.status !== "VERIFIED") console.log(cb.failure, cb.findings, cb.browser);
    expect(c.status).toBe("VERIFIED");
    const full = cb.commands.filter((x) => x.actor === "engine" && x.purpose === "test").pop()!;
    expect(full.exitCode).toBe(0);
    expect(full.output).toMatch(/monthly total equals the sum/); // original tests re-ran
    expect(JSON.parse(cb.browser).status).toBe("passed"); // UI still works in the browser after the change
    const gate = await evaluateGate(ws, productId);
    const sc = await deliveryScorecard(ws, productId);
    report.gate = gate.criteria.map((x) => `${x.id}: ${x.status}${x.required ? " (required)" : ""}`);
    report.scorecard = Object.fromEntries(Object.entries(sc.metrics).map(([k, v]) => [k, v.value ?? `unavailable: ${v.unavailable}`]));
    report.modelDouble = model.stats;
    expect(gate.criteria.find((x) => x.id === "browser")!.status).toBe("passed");

    // V11 learning, from the run's real records (processed in the background, here drained explicitly).
    await processPending(500, [ws]);
    const outcomes = await prisma.runOutcome.findMany({ where: { companyId: ws, productId } });
    const t2 = outcomes.find((o) => o.itemKey === "E1.S1.T2")!;
    expect(outcomes.map((o) => o.itemKey).sort()).toEqual(["C1.T1", "E1.S1.T1", "E1.S1.T2"]);
    expect(t2).toMatchObject({ outcome: "VERIFIED", firstPassSuccess: false, attempts: 2, browserStatus: "passed" });
    expect(t2.testsRun).toBeGreaterThan(0);
    const attr = await prisma.failureAttribution.findMany({ where: { companyId: ws, itemKey: "E1.S1.T2" } });
    // The browser-found defect (list not refreshed after save) is attributed with evidence, and the repair verified it.
    expect(attr.map((a) => [a.category, a.scope, a.status, a.verification])).toContainEqual(["architecture_contract", "agent", "ESTABLISHED", "VERIFIED"]);
    const fe = await prisma.build.findFirst({ where: { productId, itemKey: "E1.S1.T2" }, orderBy: { createdAt: "desc" } });
    const manifest = JSON.parse(fe!.retrievalManifest) as { source: string; label: string }[];
    expect(manifest.some((m) => m.source === "recipe" && m.label.startsWith("form-with-validation-states"))).toBe(true); // applicable recipe offered
    expect(JSON.parse(fe!.taskMemory).approaches?.length).toBeGreaterThan(0); // resumable task memory
    const ov = await intelligenceOverview(ws);
    report.learning = { outcomes: outcomes.map((o) => `${o.itemKey}:${o.outcome}:${o.attempts}`), attributions: attr.map((a) => `${a.category}/${a.verification}`), retrieved: manifest.map((m) => `${m.source}:${m.label}`), summary: ov.summary, recipes: ov.recipes.map((r) => `${r.key}:${r.inThisWorkspace.verified}v`) };
    expect(sc.metrics.journeysPassed.value).toBeGreaterThan(0);
    expect(sc.metrics.repairSuccess.value).toBe(1);
    expect(sc.metrics.unsupportedClaims.value).toBe(0);
  }, 900_000);
});
