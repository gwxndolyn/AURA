/**
 * Engineering run end to end WITHOUT a Docker daemon (acceptance 8, 9, 10, 14).
 *
 * TEST DOUBLES — two, both clearly labelled:
 *  - the model provider's HTTP endpoint (test/doubles/anthropic.ts): scripts
 *    what the engineer/reviewers answer; their tool calls REALLY run
 *  - the `docker` CLI (test/doubles/docker-cli.mjs): executes each sandbox
 *    command ON THE HOST in the run's working tree, with NO isolation. Only
 *    AURA's own trusted fixture code runs here.
 *
 * Everything else is real: job worker, git clone/commit/push, the tool loop
 * and callTool authorization, `npm test` (node --test) on the generated code,
 * the code index + impact analysis, defect records, repeated-failure stop,
 * project memory, scheduler settlement. When a real Docker daemon is
 * available, builder.test.ts covers the same journeys inside the sandbox.
 * This file is skipped when real Docker is available (no need for the double).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { prisma } from "@/lib/db";
import { createCompany } from "@/lib/company/provision";
import { resetClientForTests } from "@/lib/ai/claude";
import { startAnthropicDouble, type Double } from "../../../test/doubles/anthropic";
import { scripted } from "../../../test/doubles/scamscout";
import { createProduct } from "@/lib/factory/store";
import { productDetail } from "@/lib/factory/read";
import { tickProduct } from "@/lib/factory/scheduler";
import { decideProductApproval } from "@/lib/factory/release";
import { evaluateGate, deliveryReport } from "@/lib/factory/gate";
import { drain } from "@/lib/jobs/worker";
import { readAt } from "@/lib/factory/git";

const IDEA = "Build me a job scam detection platform where users can submit suspicious job listings and see a risk assessment.";
let realDocker = false;
try {
  execFileSync("docker", ["image", "inspect", "node:20-alpine"], { stdio: "ignore", timeout: 8000 });
  realDocker = true;
} catch {
  realDocker = false;
}

let user: string, ws: string, double: Double;
/** Test files share one DB/queue: drain until THIS job finished (another file's jobs may be claimed first). */
async function drainUntil(done: () => Promise<boolean>, max = 40) {
  for (let i = 0; i < max && !(await done()); i++) if (!(await drain(1, [ws]))) await new Promise((r) => setTimeout(r, 100));
}
const planned = (id: string) => async () => (await prisma.product.findUnique({ where: { id } }))?.planningStatus === "READY";
const settled = (id: string) => async () => !(await prisma.build.count({ where: { productId: id, status: { in: ["QUEUED", "RUNNING"] } } }));
const roots: string[] = [];
const savedPath = process.env.PATH;

describe.skipIf(realDocker)("engineering run with the docker CLI test double (host execution, no isolation)", () => {
  beforeAll(async () => {
    const bin = mkdtempSync(join(tmpdir(), "aura-dockerbin-"));
    roots.push(bin);
    mkdirSync(bin, { recursive: true });
    symlinkSync(resolve("test/doubles/docker-cli.mjs"), join(bin, "docker"));
    process.env.PATH = `${bin}:${savedPath}`;
    for (const k of ["AURA_GIT_ROOT", "AURA_WORK_ROOT"]) {
      const d = mkdtempSync(join(tmpdir(), `aura-dbl-${k.toLowerCase()}-`));
      roots.push(d);
      process.env[k] = d;
    }
    double = await startAnthropicDouble(scripted({ fixOnRepair: true }));
    process.env.ANTHROPIC_API_KEY = "test-key-for-double";
    process.env.ANTHROPIC_BASE_URL = double.url;
    resetClientForTests();
    const s = Date.now();
    user = (await prisma.user.create({ data: { email: `dbl_${s}@t.local`, name: "B" } })).id;
    ws = (await createCompany({ name: "DBL", mission: "m", industry: "SaaS", ownerId: user })).id;
    await prisma.subscription.create({ data: { companyId: ws, plan: "pro", status: "active" } });
  }, 60_000);

  afterAll(async () => {
    process.env.PATH = savedPath;
    await double.close();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    resetClientForTests();
    if (ws) await prisma.company.deleteMany({ where: { id: ws } });
    if (user) await prisma.user.deleteMany({ where: { id: user } });
    await prisma.$disconnect();
    for (const d of roots) rmSync(d, { recursive: true, force: true });
  });

  it("real failing test → defect → targeted repair → focused + full re-run → fix proven → commit → memory → gate", async () => {
    const r = await createProduct({ companyId: ws, userId: user, actor: "owner@test", idea: IDEA });
    await drainUntil(planned(r.product.id));
    const scope = (await productDetail(ws, r.product.id)).approvals.find((a) => a.action === "scope")!;
    await decideProductApproval(ws, r.product.id, scope.id, "owner@test", "approve");
    expect((await tickProduct(ws, r.product.id)).dispatched).toEqual(["E1.S1.T1"]);
    await drainUntil(settled(r.product.id));
    const b = (await prisma.build.findFirst({ where: { productId: r.product.id }, include: { commands: { orderBy: { createdAt: "asc" } } } }))!;
    if (b.status !== "VERIFIED") console.log(b.status, b.failure, b.commands.map((c) => `${c.actor} ${c.command} ${c.exitCode}\n${c.output.slice(0, 600)}`));
    expect(b.status).toBe("VERIFIED");
    const engineTests = b.commands.filter((c) => c.actor === "engine" && c.purpose === "test");
    expect(engineTests.map((c) => c.exitCode !== 0)).toEqual([true, false]);
    // Defect traced to the exact failing command run, and proven fixed by the passing one.
    const d = (await prisma.defect.findFirst({ where: { buildId: b.id } }))!;
    expect(d).toMatchObject({ category: "code", status: "FIXED", commandRunId: engineTests[0].id, fixedByCommandRunId: engineTests[1].id, fixedSha: null });
    expect(JSON.parse(d.failingTests)).toEqual(["upfront payment is high risk"]);
    expect(JSON.parse(d.files)).toContain("src/routes/assessments.js");
    // The repair prompt carried the evidence-based diagnosis.
    expect(double.calls.some((c) => /Likely cause: code/.test(c.lastUser) && /upfront payment is high risk/.test(c.lastUser))).toBe(true);
    // Regression checks ran: focused impacted tests first, then the full suite.
    const focused = b.commands.filter((c) => c.purpose === "focused_test");
    expect(focused.length).toBe(2);
    expect(focused[0].command).toMatch(/^node --test .*src\/routes\/assessments\.test\.js/);
    const imp = JSON.parse(b.impact);
    expect(imp.tests).toEqual(expect.arrayContaining(["src/routes/assessments.test.js", "src/server.test.js"]));
    expect(imp.flags.filter((f: { confidence: string }) => f.confidence === "confirmed")).toEqual([]);
    expect(await readAt(ws, (await prisma.product.findUnique({ where: { id: r.product.id } }))!.repoId!, b.branch, "src/routes/assessments.js")).toMatch(/toLowerCase/);
    // Memory learned only verified facts from the run.
    const mem = await prisma.projectMemory.findMany({ where: { productId: r.product.id } });
    expect(mem.find((m) => m.key === "api:POST /api/assessments")).toMatchObject({ status: "VERIFIED" });
    expect(mem.find((m) => m.kind === "defect_solution")!.content).toMatch(/upfront payment is high risk.*src\/routes\/assessments\.js/);
    await tickProduct(ws, r.product.id);
    const item = (await productDetail(ws, r.product.id)).items.find((i) => i.key === "E1.S1.T1")!;
    expect(item.status).toBe("VERIFIED");
    // The gate does not call the product done: no integrated release candidate, journeys unverified.
    const g = await evaluateGate(ws, r.product.id);
    expect(g.criteria.find((c) => c.id === "tests")!.status).toBe("passed");
    expect(g.criteria.find((c) => c.id === "requirements")!.status).toBe("passed");
    expect(g.implemented).toBe(false);
    expect(g.summary.requiredOpen).toContain("integration");
    const rep = await deliveryReport(ws, r.product.id, "owner@test");
    expect(rep.defects).toMatchObject({ total: 1, fixed: 1, open: 0 });
  }, 300_000);

  it("an unproductive repair (same failure, unchanged code) stops within the limit and is never verified", async () => {
    double.setResponder(scripted({ fixOnRepair: false }));
    const r = await createProduct({ companyId: ws, userId: user, actor: "owner@test", idea: `${IDEA} (2)` });
    await drainUntil(planned(r.product.id));
    const scope = (await productDetail(ws, r.product.id)).approvals.find((a) => a.action === "scope")!;
    await decideProductApproval(ws, r.product.id, scope.id, "owner@test", "approve");
    await prisma.product.update({ where: { id: r.product.id }, data: { limits: JSON.stringify({ maxRepairs: 4, maxAttempts: 1, maxParallel: 1 }) } });
    await tickProduct(ws, r.product.id);
    await drainUntil(settled(r.product.id));
    const b = (await prisma.build.findFirst({ where: { productId: r.product.id } }))!;
    expect(b.status).toBe("FAILED");
    // Baseline stops on the unchanged tree; adaptive-v1 (default) first investigates once, then stops with the controller's reason.
    expect(["repeated_failure", "strategy_exhausted"]).toContain(b.stopReason);
    expect(b.attempt).toBeLessThan(4); // stopped before exhausting 5 attempts
    expect((await prisma.defect.findFirst({ where: { buildId: b.id } }))!.status).toBe("ABANDONED");
    await tickProduct(ws, r.product.id);
    expect((await productDetail(ws, r.product.id)).items.find((i) => i.key === "E1.S1.T1")!.status).not.toBe("VERIFIED");
    double.setResponder(scripted({ fixOnRepair: true }));
  }, 300_000);
});
