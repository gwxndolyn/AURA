/**
 * V16 strategy benchmark — the same 8 tasks run through the REAL engine
 * (planning job → scope approval → scheduler → build jobs → engineer tool use
 * executed → npm test → review → commit / repair / stop) twice: once under the
 * `baseline` policy (one strategy for every task) and once under
 * `adaptive-v1`. Results come from persisted Build rows, not from the double.
 *
 * TEST DOUBLES: the model provider (test/doubles/adaptive-bench.ts — its
 * behaviour model is documented there) and, when no Docker daemon is
 * available, the `docker` CLI (test/doubles/docker-cli.mjs: host execution,
 * NO isolation; only AURA's own fixture code runs). With real Docker the
 * sandbox is used.
 *
 * Fixed acceptance criteria (never relaxed to make a run pass):
 *  - adaptive-v1 verifies at least as many of the 7 WELL-SPECIFIED tasks as
 *    baseline (the ambiguous task is excluded: "verifying" an unmeasurable
 *    criterion is not a success — corrected after the first run, see
 *    docs/architecture/adaptive-execution.md#benchmark)
 *  - adaptive-v1 verifies more tasks on the first attempt
 *  - adaptive-v1 blocks the ambiguous task BEFORE any model call; baseline does not
 *  - the stuck task never reaches VERIFIED under either policy
 *  - every adaptive run persisted its plan (classification evidence + strategy + verification status)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { prisma } from "@/lib/db";
import { createCompany } from "@/lib/company/provision";
import { resetClientForTests } from "@/lib/ai/claude";
import { createProduct } from "@/lib/factory/store";
import { productDetail } from "@/lib/factory/read";
import { tickProduct } from "@/lib/factory/scheduler";
import { decideProductApproval } from "@/lib/factory/release";
import { drain } from "@/lib/jobs/worker";
import { setExecutionPolicy, strategyMetrics, type ExecutionPlanRecord } from "./planner";
import { startAnthropicDouble, type Double } from "../../../test/doubles/anthropic";
import { benchScripted, IDEA, SPECS } from "../../../test/doubles/adaptive-bench";

let realDocker = false;
try {
  execFileSync("docker", ["image", "inspect", "node:20-alpine"], { stdio: "ignore", timeout: 8000 });
  realDocker = true;
} catch {
  realDocker = false;
}

let user = "", ws = "", double: Double;
const roots: string[] = [];
const savedPath = process.env.PATH;
const model = benchScripted();

async function until(fn: () => Promise<boolean>, max = 400) {
  for (let i = 0; i < max && !(await fn()); i++) if (!(await drain(1, [ws]))) await new Promise((r) => setTimeout(r, 100));
}

/** Run all 8 tasks of a fresh product under `policy`; return the persisted per-task outcomes. */
async function runPolicy(policy: "baseline" | "adaptive-v1") {
  const r = await createProduct({ companyId: ws, userId: user, actor: "owner@test", idea: `${IDEA} [${policy}]`, limits: { maxRepairs: 3, maxAttempts: 1, maxParallel: 2, budgetUsd: 2, projectBudgetUsd: 100 } });
  const pid = r.product.id;
  await setExecutionPolicy(ws, pid, { adaptivePolicy: policy });
  await until(async () => (await prisma.product.findUnique({ where: { id: pid } }))?.planningStatus === "READY");
  const scope = (await productDetail(ws, pid)).approvals.find((a) => a.action === "scope")!;
  await decideProductApproval(ws, pid, scope.id, "owner@test", "approve");
  for (let i = 0; i < 20; i++) {
    await tickProduct(ws, pid);
    await until(async () => !(await prisma.build.count({ where: { productId: pid, status: { in: ["QUEUED", "RUNNING"] } } })));
    const builds = await prisma.build.findMany({ where: { productId: pid, status: { in: ["VERIFIED", "FAILED", "BLOCKED"] } }, select: { itemKey: true } });
    if (SPECS.every((s) => builds.some((b) => b.itemKey === s.key))) break;
  }
  const builds = await prisma.build.findMany({ where: { productId: pid }, orderBy: { createdAt: "asc" } });
  return { pid, rows: SPECS.map((s) => {
    const b = builds.find((x) => x.itemKey === s.key)!;
    const plan = JSON.parse(b?.executionPlan || "{}") as Partial<ExecutionPlanRecord>;
    return { key: s.key, name: s.name, status: b?.status ?? "MISSING", attempts: b ? (b.status === "BLOCKED" && !b.modelCalls ? 0 : b.attempt + 1) : 0, modelCalls: b?.modelCalls ?? 0, costUsd: b?.costUsd ?? 0, stopReason: b?.stopReason ?? "", strategy: plan.strategy?.strategy ?? null, adjustments: (plan.adjustments ?? []).map((a) => a.action), plan, failure: b?.failure ?? "" };
  }) };
}

describe("V16 strategy benchmark: baseline vs adaptive-v1 on 8 tasks (real engine)", () => {
  beforeAll(async () => {
    if (!realDocker) {
      const bin = mkdtempSync(join(tmpdir(), "aura-v16bin-"));
      roots.push(bin);
      symlinkSync(resolve("test/doubles/docker-cli.mjs"), join(bin, "docker"));
      process.env.PATH = `${bin}:${savedPath}`;
    }
    for (const k of ["AURA_GIT_ROOT", "AURA_WORK_ROOT"]) {
      const d = mkdtempSync(join(tmpdir(), `aura-v16-${k.toLowerCase()}-`));
      roots.push(d);
      process.env[k] = d;
    }
    double = await startAnthropicDouble(model);
    process.env.ANTHROPIC_API_KEY = "test-key-for-double";
    process.env.ANTHROPIC_BASE_URL = double.url;
    resetClientForTests();
    const s = Date.now();
    user = (await prisma.user.create({ data: { email: `v16_${s}@t.local`, name: "B" } })).id;
    ws = (await createCompany({ name: "V16", mission: "m", industry: "SaaS", ownerId: user })).id;
    await prisma.subscription.create({ data: { companyId: ws, plan: "team", status: "active" } });
  }, 60_000);

  afterAll(async () => {
    process.env.PATH = savedPath;
    await double?.close();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    resetClientForTests();
    if (ws) await prisma.company.deleteMany({ where: { id: ws } });
    if (user) await prisma.user.deleteMany({ where: { id: user } });
    for (const d of roots) rmSync(d, { recursive: true, force: true });
  });

  it("adaptive-v1 beats the baseline on verified-first-attempt without losing verified tasks; decisions are persisted", async () => {
    const base = await runPolicy("baseline");
    const adapt = await runPolicy("adaptive-v1");
    const sum = (rows: typeof base.rows) => ({
      verified: rows.filter((r) => r.status === "VERIFIED").length,
      firstAttempt: rows.filter((r) => r.status === "VERIFIED" && r.attempts === 1).length,
      attempts: rows.reduce((s, r) => s + r.attempts, 0),
      modelCalls: rows.reduce((s, r) => s + r.modelCalls, 0),
      costUsd: Number(rows.reduce((s, r) => s + r.costUsd, 0).toFixed(4)),
      blockedBeforeWork: rows.filter((r) => r.status === "BLOCKED" && r.modelCalls === 0).length,
    });
    const report = {
      sandbox: realDocker ? "docker" : "docker CLI test double (host execution, no isolation)",
      model: "test double (test/doubles/adaptive-bench.ts)",
      baseline: { summary: sum(base.rows), tasks: base.rows.map(({ plan: _p, failure: _f, ...r }) => r) },
      adaptive: { summary: sum(adapt.rows), tasks: adapt.rows.map(({ plan: _p, failure: _f, ...r }) => r) },
      metrics: await strategyMetrics(ws),
    };
    writeFileSync(join(tmpdir(), "aura-v16-benchmark.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ baseline: report.baseline, adaptive: report.adaptive }, null, 1));

    const b = report.baseline.summary, a = report.adaptive.summary;
    const wellSpecified = (rows: typeof base.rows) => rows.filter((r) => r.name !== "dashboard" && r.status === "VERIFIED").length;
    expect(wellSpecified(adapt.rows)).toBeGreaterThanOrEqual(wellSpecified(base.rows));
    expect(a.firstAttempt).toBeGreaterThan(b.firstAttempt);
    // Ambiguous task: adaptive stops for clarification before spending anything; baseline builds it.
    const amb = (rows: typeof base.rows) => rows.find((r) => r.name === "dashboard")!;
    expect(amb(adapt.rows)).toMatchObject({ status: "BLOCKED", modelCalls: 0 });
    expect(amb(adapt.rows).failure).toMatch(/too ambiguous/);
    expect(amb(base.rows).modelCalls).toBeGreaterThan(0);
    // Stuck task: never verified; adaptive stops via controller or repeated-failure detection, with the reason recorded.
    for (const rows of [base.rows, adapt.rows]) expect(rows.find((r) => r.name === "sum")!.status).toBe("FAILED");
    expect(["repeated_failure", "strategy_exhausted"]).toContain(adapt.rows.find((r) => r.name === "sum")!.stopReason);
    // Strategy is task-specific (not one strategy for everything) and every plan carries evidence.
    const strategies = new Set(adapt.rows.map((r) => r.strategy));
    expect(strategies.size).toBeGreaterThanOrEqual(3);
    expect(new Set(base.rows.map((r) => r.strategy))).toEqual(new Set(["direct"]));
    expect(adapt.rows.find((r) => r.name === "notecount")!.strategy).toBe("test_driven_repair");
    expect(adapt.rows.find((r) => r.name === "notes")!.strategy).toBe("high_assurance");
    for (const r of adapt.rows) {
      expect(r.plan.policy).toBe("adaptive-v1");
      expect(r.plan.classification!.category.evidence.length).toBeGreaterThan(0);
      if (r.status === "VERIFIED") expect(r.plan.verificationStatus!.rows.length).toBeGreaterThan(0);
    }
    // The high-risk authorization task: verification depth recorded and authorization tests evidenced.
    const notes = adapt.rows.find((r) => r.name === "notes")!;
    expect(notes.plan.verification!.map((v) => v.id)).toEqual(expect.arrayContaining(["security_review", "authorization_tests", "explicit_approval"]));
    if (notes.status === "VERIFIED") expect(notes.plan.verificationStatus!.rows.find((x) => x.id === "authorization_tests")!.status).toBe("passed");
    // Metrics are measured from persisted runs per policy.
    expect(report.metrics.byPolicy.baseline.runs).toBe(8);
    expect(report.metrics.byPolicy["adaptive-v1"].runs).toBe(8);
  }, 900_000);
});
