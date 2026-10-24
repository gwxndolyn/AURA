/**
 * Builder acceptance tests (journeys 2, 3, 4, 5, 10).
 *
 * Real: Prisma DB, job queue + worker, the Anthropic SDK + tool-use loop,
 * callTool authorization, git repositories, the Docker sandbox (npm test runs
 * for real), verification, commits. Test double: ONLY the model provider's
 * HTTP endpoint (test/doubles/anthropic.ts) scripts what the model answers,
 * so no paid model calls happen in CI. Docker-dependent steps are skipped
 * (not faked) without Docker.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@/lib/db";
import { createCompany } from "@/lib/company/provision";
import { dockerAvailable } from "@/lib/sandbox/docker";
import { resetClientForTests } from "@/lib/ai/claude";
import { startAnthropicDouble, type Double } from "../../../test/doubles/anthropic";
import { scripted } from "../../../test/doubles/scamscout";
import { createProduct } from "@/lib/factory/store";
import { productDetail } from "@/lib/factory/read";
import { tickProduct } from "@/lib/factory/scheduler";
import { decideProductApproval } from "@/lib/factory/release";
import { drain } from "@/lib/jobs/worker";
import { enqueue, claim } from "@/lib/jobs/queue";
import { readAt } from "@/lib/factory/git";
import { isAllowedCommand, isDaemonFailure } from "./sandbox";

const IDEA = "Build me a job scam detection platform where users can submit suspicious job listings, analyse potential scam indicators, and view a dashboard of risk assessments.";

let user: string, ws: string, other: string, otherWs: string, docker = false, double: Double;
/** Test files share one DB/queue: drain until THIS file's work finished (another file's jobs may be claimed first). */
async function drainUntil(done: () => Promise<boolean>, max = 40) {
  for (let i = 0; i < max && !(await done()); i++) if (!(await drain(1, [ws, otherWs]))) await new Promise((r) => setTimeout(r, 100));
}
const planned = (id: string) => async () => ["READY", "FAILED"].includes((await prisma.product.findUnique({ where: { id } }))?.planningStatus ?? "");
const settled = (id: string) => async () => !(await prisma.build.count({ where: { productId: id, status: { in: ["QUEUED", "RUNNING"] } } }));
const roots: string[] = [];

beforeAll(async () => {
  docker = await dockerAvailable();
  for (const k of ["AURA_GIT_ROOT", "AURA_WORK_ROOT"]) {
    const d = mkdtempSync(join(tmpdir(), `aura-${k.toLowerCase()}-`));
    roots.push(d);
    process.env[k] = d;
  }
  double = await startAnthropicDouble(scripted({ fixOnRepair: true }));
  process.env.ANTHROPIC_API_KEY = "test-key-for-double";
  process.env.ANTHROPIC_BASE_URL = double.url;
  resetClientForTests();
  const s = Date.now();
  user = (await prisma.user.create({ data: { email: `bld_${s}@t.local`, name: "B" } })).id;
  other = (await prisma.user.create({ data: { email: `bld_o_${s}@t.local`, name: "O" } })).id;
  ws = (await createCompany({ name: "BUILD", mission: "m", industry: "SaaS", ownerId: user })).id;
  otherWs = (await createCompany({ name: "BUILD-O", mission: "m", industry: "SaaS", ownerId: other })).id;
  // Plan limits for the test workspace (paid plan entitlements are normally set only by verified billing webhooks).
  await prisma.subscription.create({ data: { companyId: ws, plan: "pro", status: "active" } });
}, 60_000);

afterAll(async () => {
  await double.close();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  resetClientForTests();
  await prisma.company.deleteMany({ where: { id: { in: [ws, otherWs] } } });
  await prisma.user.deleteMany({ where: { id: { in: [user, other] } } });
  await prisma.$disconnect();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

describe("sandbox command policy", () => {
  it("only allowlisted commands, no shell operators", () => {
    expect(isAllowedCommand("npm test")).toBe(true);
    expect(isAllowedCommand("npm install --ignore-scripts")).toBe(true);
    expect(isAllowedCommand("node --test src/a.test.js")).toBe(true);
    expect(isDaemonFailure(125, "docker: Error response from daemon: input/output error")).toBe(true);
    expect(isDaemonFailure(1, "not ok 2 - upfront payment is high risk")).toBe(false);
    for (const bad of ["npm test; cat /etc/passwd", "curl http://x", "npm test && rm -rf /", "node -e 'process.env'", "sh -c id", "npm run x`id`", "cat $HOME/.npmrc"]) expect(isAllowedCommand(bad), bad).toBe(false);
  });
});

describe("product planning and engineering run (real execution)", () => {
  let productId = "";

  it("journey 2: the PM model's structured plan is validated and saved; the starter repo is real", async () => {
    const r = await createProduct({ companyId: ws, userId: user, actor: "owner@test", idea: IDEA });
    productId = r.product.id;
    expect(r.product.planningStatus).toBe("QUEUED");
    await drainUntil(planned(productId)); // the worker runs the planning job
    const d = await productDetail(ws, productId);
    expect(d.product.title).toBe("ScamScout");
    expect(d.product.planningStatus).toBe("READY");
    expect(d.brief?.source).toBe("model");
    const t = d.items.find((i) => i.key === "E1.S1.T1")!;
    expect(t.acceptance).toHaveLength(3);
    expect(t.executable).toBe(true);
    expect(d.approvals.find((a) => a.action === "scope")?.status).toBe("PENDING");
    expect(await readAt(ws, d.repo!.id, "main", "src/server.js")).toMatch(/createServer/);
    expect(double.calls.filter((c) => /Product Manager/.test(c.system)).length).toBe(2);
  }, 60_000);

  it("journeys 3–5: real files written by tool calls, real failing test, repair, re-verification, commit", async () => {
    if (!docker) return; // execution requires the sandbox; skipped, not faked
    const scope = (await productDetail(ws, productId)).approvals.find((a) => a.action === "scope")!;
    await decideProductApproval(ws, productId, scope.id, "owner@test", "approve");
    const t1 = await tickProduct(ws, productId);
    expect(t1.dispatched).toContain("E1.S1.T1");
    let d = await productDetail(ws, productId);
    expect(d.items.find((i) => i.key === "E1.S1.T1")!.status).toBe("IN_PROGRESS");
    await drainUntil(settled(productId)); // the worker executes the build job
    const build = await prisma.build.findFirst({ where: { companyId: ws, productId }, include: { commands: { orderBy: { createdAt: "asc" } } } });
    if (build!.status !== "VERIFIED") {
      console.log("BUILD", build!.status, build!.attempt, build!.failure.slice(0, 1500));
      for (const c of build!.commands) console.log("CMD", c.actor, c.command, c.exitCode, JSON.stringify(c.output.slice(0, 1500)));
      for (const t of await prisma.toolCall.findMany({ where: { run: { companyId: ws } }, orderBy: { createdAt: "asc" } })) console.log("TOOL", t.tool, t.status, t.output.slice(0, 160));
    }
    expect(build!.status).toBe("VERIFIED");
    // Attempt 1 really failed: the engine's npm test exited non-zero on the case-sensitivity bug.
    const engineTests = build!.commands.filter((c) => c.actor === "engine" && c.purpose === "test");
    expect(engineTests.length).toBe(2);
    expect(engineTests[0].exitCode).not.toBe(0);
    expect(engineTests[0].output).toMatch(/upfront payment is high risk/);
    expect(engineTests[1].exitCode).toBe(0);
    expect(engineTests[1].output).toMatch(/# pass 5/);
    expect(build!.attempt).toBe(1);
    // The engineer also ran the tests itself through the tool (recorded).
    expect(build!.commands.some((c) => c.actor === "backend-engineer" && c.command === "npm test")).toBe(true);
    // Tool calls are recorded and authorized through callTool.
    const toolCalls = await prisma.toolCall.findMany({ where: { run: { companyId: ws } } });
    expect(toolCalls.some((t) => t.tool === "fs.write" && t.ok)).toBe(true);
    // The verified code is committed on the task branch; main is untouched.
    expect(await readAt(ws, d.repo!.id, build!.branch, "src/routes/assessments.js")).toMatch(/toLowerCase\(\)\.includes/);
    expect(await readAt(ws, d.repo!.id, "main", "src/routes/assessments.js")).toBeNull();
    // Scheduler settles the task from the recorded evidence.
    await tickProduct(ws, productId);
    d = await productDetail(ws, productId);
    const t = d.items.find((i) => i.key === "E1.S1.T1")!;
    expect(t.status).toBe("VERIFIED");
    expect(t.evidence.some((e) => e.kind === "test_run" && /exit 0/.test(e.detail))).toBe(true);
    expect(t.evidence.filter((e) => e.kind === "criterion").every((e) => e.ref === "met")).toBe(true);
    // V3: the failure became a defect, fixed and proven by the passing engine run; impact + memory recorded.
    const defects = await prisma.defect.findMany({ where: { buildId: build!.id } });
    expect(defects).toHaveLength(1);
    expect(defects[0]).toMatchObject({ category: "code", status: "FIXED", commandRunId: engineTests[0].id, fixedByCommandRunId: engineTests[1].id });
    expect(JSON.parse(defects[0].failingTests)).toEqual(["upfront payment is high risk"]);
    expect(build!.commands.some((c) => c.purpose === "focused_test" && /assessments\.test\.js/.test(c.command))).toBe(true);
    expect(JSON.parse(build!.impact).tests).toContain("src/routes/assessments.test.js");
    const mem = await prisma.projectMemory.findMany({ where: { companyId: ws, productId } });
    expect(mem.find((m) => m.key === "api:POST /api/assessments")?.status).toBe("VERIFIED");
    expect(mem.find((m) => m.kind === "defect_solution")?.content).toMatch(/assessments\.js/);
    const usage = await prisma.usageEvent.findMany({ where: { companyId: ws } });
    expect(usage.some((u) => u.metric === "ai_tokens_in" && u.quantity > 0)).toBe(true);
    expect(usage.some((u) => u.metric === "sandbox_ms" && u.quantity > 0)).toBe(true);
  }, 600_000);

  it("journey 5 (honest failure): if the agent cannot fix it, the run FAILS with the real output and the task is never verified", async () => {
    if (!docker) return;
    double.setResponder(scripted({ fixOnRepair: false }));
    const r = await createProduct({ companyId: ws, userId: user, actor: "owner@test", idea: IDEA + " (second)" });
    await drainUntil(planned(r.product.id));
    const scope = (await productDetail(ws, r.product.id)).approvals.find((a) => a.action === "scope")!;
    await decideProductApproval(ws, r.product.id, scope.id, "owner@test", "approve");
    await prisma.product.update({ where: { id: r.product.id }, data: { limits: JSON.stringify({ maxRepairs: 1, maxAttempts: 1, maxParallel: 1, budgetUsd: 1 }) } });
    await tickProduct(ws, r.product.id);
    await drainUntil(settled(r.product.id));
    const build = await prisma.build.findFirst({ where: { productId: r.product.id } });
    expect(build!.status).toBe("FAILED");
    expect(build!.failure).toMatch(/Not verified after 2 attempt/);
    expect(build!.failure).toMatch(/upfront payment is high risk/);
    // V3: an unchanged repair is detected as a repeated failure; the defect is abandoned, not "fixed".
    expect(build!.stopReason).toBe("repeated_failure");
    expect((await prisma.defect.findFirst({ where: { buildId: build!.id } }))!.status).toBe("ABANDONED");
    await tickProduct(ws, r.product.id);
    const t = (await productDetail(ws, r.product.id)).items.find((i) => i.key === "E1.S1.T1")!;
    expect(["FAILED", "BLOCKED"]).toContain(t.status);
    expect(t.status).not.toBe("VERIFIED");
    double.setResponder(scripted({ fixOnRepair: true }));
  }, 600_000);

  it("journey 10: provider outage → planning job retries, then fails honestly with a recovery path; no duplicate jobs", async () => {
    double.setResponder(() => ({ error: 529 }));
    const r = await createProduct({ companyId: ws, userId: user, actor: "owner@test", idea: IDEA + " (outage)" });
    const again = await enqueue({ companyId: ws, type: "product.plan", payload: { productId: r.product.id }, dedupeKey: `plan:${r.product.id}:1`, createdBy: "x" });
    expect(again.id).toBe(r.jobId); // idempotent: no duplicate work
    await drain(1, [ws]);
    let job = await prisma.job.findUnique({ where: { id: r.jobId } });
    expect(job!.status).toBe("QUEUED"); // retryable: backed off
    expect(job!.errorKind).toBe("provider_overloaded");
    for (let i = 0; i < 3; i++) {
      await prisma.job.update({ where: { id: r.jobId }, data: { runAt: new Date() } });
      await drain(1, [ws]);
    }
    job = await prisma.job.findUnique({ where: { id: r.jobId } });
    expect(job!.status).toBe("DEAD");
    const p = await prisma.product.findUnique({ where: { id: r.product.id } });
    expect(p!.planningStatus).toBe("FAILED");
    expect(p!.planningError).toMatch(/overloaded/);
    expect(await prisma.backlogItem.count({ where: { productId: r.product.id } })).toBe(0); // nothing fabricated
    double.setResponder(scripted({ fixOnRepair: true }));
  }, 120_000);

  it("journey 10: a crashed worker's lease is reclaimed exactly once", async () => {
    const j = await enqueue({ companyId: ws, type: "noop.test", payload: {}, createdBy: "t" });
    const first = await claim("w1", ["noop.test"]);
    expect(first!.id).toBe(j.id);
    expect(await claim("w2", ["noop.test"])).toBeNull(); // lease held
    await prisma.job.update({ where: { id: j.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    const again = await claim("w2", ["noop.test"]);
    expect(again!.id).toBe(j.id);
    expect(again!.attempts).toBe(2);
    expect(await claim("w3", ["noop.test"])).toBeNull();
    await prisma.job.update({ where: { id: j.id }, data: { status: "CANCELLED" } });
  });

  it("journey 7: another workspace cannot read builds or products", async () => {
    await expect(productDetail(otherWs, productId)).rejects.toThrow(/not found/i);
    const b = await prisma.build.findFirst({ where: { companyId: ws } });
    if (b) expect(await prisma.build.findFirst({ where: { id: b.id, companyId: otherWs } })).toBeNull();
  });
});
