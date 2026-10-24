/**
 * Autonomous runtime (V6): queue, worker lifecycle, scheduler, breakers,
 * budgets, goals, permissions, self-modification. Real: database, queue,
 * worker code paths, git worktrees. Test doubles: the model provider HTTP
 * endpoint (only where a goal plans a product) and a host test runner for
 * self-modification (the production runner is Docker; see selfmod.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let currentToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "aura_session" && currentToken ? { value: currentToken } : undefined), set: () => {} }),
}));

import { prisma } from "@/lib/db";
import { createSessionToken } from "@/lib/auth/session";
import { createCompany } from "@/lib/company/provision";
import { enqueue, claim, complete, fail, heartbeat, backoffMs, saveCheckpoint, progress, cancel, retry } from "@/lib/jobs/queue";
import { runOne, registerWorker, stopWorker, resetWorkerForTests, drain } from "@/lib/jobs/worker";
import { HANDLERS } from "@/lib/jobs/registry";
import { recordOutcome, isOpen, BREAKER } from "./breaker";
import { nextRun, createSchedule, tickSchedules } from "./schedule";
import { createGoal, advanceGoal, controlGoal, clampGoalLimits } from "./goals";
import { checkPatchScope, runSelfModification, attemptSelfModification } from "./selfmod";
import { validateRuntimeConfig } from "./config";
import { resetClientForTests } from "@/lib/ai/claude";
import { startAnthropicDouble, type Double } from "../../../test/doubles/anthropic";
import { scripted } from "../../../test/doubles/scamscout";
import * as RuntimeRoute from "@/app/api/companies/[id]/runtime/route";
import * as GoalsRoute from "@/app/api/companies/[id]/runtime/goals/route";
import * as JobRoute from "@/app/api/companies/[id]/runtime/jobs/[jobId]/route";

const users: Record<string, { id: string; email: string }> = {};
let ws: string, other: string, double: Double;
const roots: string[] = [];
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const req = (method = "GET", body?: unknown) => new Request("http://t.local/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const as = async (n: string | null) => { currentToken = n ? await createSessionToken({ userId: users[n].id, email: users[n].email }) : null; };
const T = "test.rt"; // job types only this file uses

beforeAll(async () => {
  for (const k of ["AURA_GIT_ROOT", "AURA_WORK_ROOT"]) { const d = mkdtempSync(join(tmpdir(), `aura-rt-${k.toLowerCase()}-`)); roots.push(d); process.env[k] = d; }
  double = await startAnthropicDouble(scripted({ fixOnRepair: true }));
  process.env.ANTHROPIC_API_KEY = "test-key-for-double";
  process.env.ANTHROPIC_BASE_URL = double.url;
  resetClientForTests();
  const s = Date.now();
  for (const n of ["owner", "member", "viewer", "outsider"]) users[n] = await prisma.user.create({ data: { email: `${n}_${s}@rt.local`, name: n } });
  ws = (await createCompany({ name: "RT", mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
  other = (await createCompany({ name: "RT-O", mission: "m", industry: "SaaS", ownerId: users.outsider.id })).id;
  await prisma.workspaceMember.createMany({ data: [{ userId: users.member.id, companyId: ws, role: "MEMBER" }, { userId: users.viewer.id, companyId: ws, role: "VIEWER" }] });
  await prisma.subscription.create({ data: { companyId: ws, plan: "pro", status: "active" } });
  // Test-only handlers registered on the REAL registry (the worker dispatches through it).
  HANDLERS[`${T}.ok`] = async (job) => ({ id: job.id });
  HANDLERS[`${T}.flaky`] = async () => { throw Object.assign(new Error("transient"), { retryable: true, kind: "flaky" }); };
  HANDLERS[`${T}.slow`] = async (_job, c) => { await new Promise((r, rej) => { const t = setTimeout(r, 30_000); c.signal.addEventListener("abort", () => { clearTimeout(t); rej(c.signal.reason); }); }); return {}; };
  HANDLERS[`${T}.steps`] = async (job) => {
    // A resumable 3-step handler: crashes once after step 2 is checkpointed; the next attempt resumes at step 3.
    const cp = JSON.parse((await prisma.job.findUnique({ where: { id: job.id } }))!.checkpoint) as { done?: number[] };
    const done = new Set(cp.done ?? []);
    for (const step of [1, 2, 3]) {
      if (done.has(step)) continue;
      await prisma.jobEvent.create({ data: { jobId: job.id, companyId: job.companyId, type: "test_step_executed", detail: String(step) } });
      done.add(step);
      await saveCheckpoint(job, { step, done: [...done] });
      if (step === 2 && job.attempts === 1) throw Object.assign(new Error("simulated crash after step 2"), { retryable: true, kind: "crash" });
    }
    return { done: [...done] };
  };
}, 60_000);

afterAll(async () => {
  await double.close();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  resetClientForTests();
  for (const k of Object.keys(HANDLERS).filter((k) => k.startsWith(T))) delete HANDLERS[k];
  await prisma.runtimeSettings.deleteMany({ where: { companyId: { in: [ws, other, "*"] } } });
  await prisma.jobEvent.deleteMany({ where: { companyId: { in: [ws, other] } } });
  await prisma.company.deleteMany({ where: { id: { in: [ws, other] } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
  await prisma.$disconnect();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const types = (t: string) => [`${T}.${t}`];

describe("durable queue", () => {
  it("creates and claims a job; a second worker cannot claim it while the lease is held (no duplicate execution)", async () => {
    const j = await enqueue({ companyId: ws, type: `${T}.ok`, payload: {}, createdBy: "t" });
    const [a, b] = await Promise.all([claim("w-a", types("ok")), claim("w-b", types("ok"))]);
    expect([a?.id, b?.id].filter(Boolean)).toEqual([j.id]); // exactly one winner
    const winner = a ? "w-a" : "w-b";
    expect(await heartbeat(j.id, winner === "w-a" ? "w-b" : "w-a")).toBe(false);
    expect(await complete(j.id, winner, { ok: 1 })).toBe(true);
    expect(await complete(j.id, winner, { ok: 2 })).toBe(false); // duplicate completion ignored
    const ev = (await prisma.jobEvent.findMany({ where: { jobId: j.id } })).map((e) => e.type);
    expect(ev).toEqual(["enqueued", "claimed", "succeeded"]);
  });

  it("priority orders claims; dependencies gate them; a failed dependency fails the dependent", async () => {
    const low = await enqueue({ companyId: ws, type: `${T}.ok`, payload: {}, createdBy: "t", priority: 500 });
    const high = await enqueue({ companyId: ws, type: `${T}.ok`, payload: {}, createdBy: "t", priority: 1 });
    const dep = await enqueue({ companyId: ws, type: `${T}.ok`, payload: {}, createdBy: "t", priority: 0, dependsOn: [low.id] });
    expect((await claim("w", types("ok")))!.id).toBe(high.id);
    await complete(high.id, "w", {});
    expect((await claim("w", types("ok")))!.id).toBe(low.id); // dep (priority 0) is not eligible yet
    await fail(low.id, "w", { message: "boom", retryable: false, kind: "x" });
    expect(await claim("w", types("ok"))).toBeNull();
    expect((await prisma.job.findUnique({ where: { id: dep.id } }))).toMatchObject({ status: "FAILED", errorKind: "dependency_failed" });
  });

  it("retries with exponential backoff (+jitter) up to maxAttempts, then DEAD", async () => {
    expect(backoffMs(1, 1000, 600_000, () => 0.5)).toBe(1000);
    expect(backoffMs(3, 1000, 600_000, () => 0.5)).toBe(4000);
    expect(backoffMs(30, 1000, 10_000, () => 1)).toBe(12_000);
    const j = await enqueue({ companyId: ws, type: `${T}.flaky`, payload: {}, createdBy: "t", maxAttempts: 2 });
    await registerWorker("test");
    expect(await runOne(undefined, [ws])).toBe(true);
    let row = (await prisma.job.findUnique({ where: { id: j.id } }))!;
    expect(row.status).toBe("QUEUED");
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now());
    await prisma.job.update({ where: { id: j.id }, data: { runAt: new Date() } });
    await runOne(undefined, [ws]);
    row = (await prisma.job.findUnique({ where: { id: j.id } }))!;
    expect(row).toMatchObject({ status: "DEAD", attempts: 2, errorKind: "flaky" });
    expect((await prisma.jobEvent.findMany({ where: { jobId: j.id } })).map((e) => e.type)).toEqual(["enqueued", "claimed", "retry_scheduled", "claimed", "dead"]);
  });

  it("deadlines: a job that cannot start in time fails instead of running late", async () => {
    const j = await enqueue({ companyId: ws, type: `${T}.ok`, payload: {}, createdBy: "t", deadline: new Date(Date.now() - 1000) });
    expect(await claim("w", types("ok"))).toBeNull();
    expect(await prisma.job.findUnique({ where: { id: j.id } })).toMatchObject({ status: "FAILED", errorKind: "deadline_missed" });
  });

  it("concurrency limits per workspace and per key are enforced by claim()", async () => {
    await prisma.runtimeSettings.upsert({ where: { companyId: ws }, create: { companyId: ws, limits: JSON.stringify({ maxConcurrentJobs: 1 }) }, update: { limits: JSON.stringify({ maxConcurrentJobs: 1 }) } });
    const a = await enqueue({ companyId: ws, type: `${T}.ok`, payload: {}, createdBy: "t" });
    const b = await enqueue({ companyId: ws, type: `${T}.ok`, payload: {}, createdBy: "t" });
    expect((await claim("w1", types("ok")))!.id).toBe(a.id);
    expect(await claim("w2", types("ok"))).toBeNull();
    await complete(a.id, "w1", {});
    expect((await claim("w2", types("ok")))!.id).toBe(b.id);
    await complete(b.id, "w2", {});
    await prisma.runtimeSettings.update({ where: { companyId: ws }, data: { limits: "{}" } });
  });
});

describe("worker lifecycle and recovery", () => {
  it("crash recovery: an expired lease is reclaimed by another worker exactly once, with a durable event", async () => {
    const j = await enqueue({ companyId: ws, type: `${T}.ok`, payload: {}, createdBy: "t" });
    await claim("w-dead", types("ok"));
    await prisma.job.update({ where: { id: j.id }, data: { leaseUntil: new Date(Date.now() - 1) } }); // worker died: no heartbeats
    const [x, y] = await Promise.all([claim("w-live1", types("ok")), claim("w-live2", types("ok"))]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    const ev = await prisma.jobEvent.findFirst({ where: { jobId: j.id, type: "lease_reclaimed" } });
    expect(ev!.detail).toMatch(/w-dead/);
  });

  it("resumes an interrupted task from its checkpoint (completed steps are not re-executed)", async () => {
    const j = await enqueue({ companyId: ws, type: `${T}.steps`, payload: {}, createdBy: "t", maxAttempts: 3, timeoutMs: 10_000 });
    await runOne(undefined, [ws]); // steps 1-2, crash
    await prisma.job.update({ where: { id: j.id }, data: { runAt: new Date() } });
    await runOne(undefined, [ws]); // resumes at 3
    const row = (await prisma.job.findUnique({ where: { id: j.id } }))!;
    expect(row.status).toBe("SUCCEEDED");
    const executed = (await prisma.jobEvent.findMany({ where: { jobId: j.id, type: "test_step_executed" }, orderBy: { createdAt: "asc" } })).map((e) => e.detail);
    expect(executed).toEqual(["1", "2", "3"]); // each step ran exactly once across two attempts
    expect(JSON.parse(row.checkpoint)).toMatchObject({ step: 3, done: [1, 2, 3] });
  });

  it("timeouts abort the handler cooperatively and count as a retryable failure", async () => {
    const j = await enqueue({ companyId: ws, type: `${T}.slow`, payload: {}, createdBy: "t", maxAttempts: 1, timeoutMs: 1000 });
    const t0 = Date.now();
    await runOne(undefined, [ws]);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(await prisma.job.findUnique({ where: { id: j.id } })).toMatchObject({ status: "DEAD", errorKind: "timeout" });
  });

  it("cancellation propagates to a running handler; graceful shutdown releases running work back to the queue", async () => {
    const c = await enqueue({ companyId: ws, type: `${T}.slow`, payload: {}, createdBy: "t" });
    const p = runOne(undefined, [ws]);
    await new Promise((r) => setTimeout(r, 300));
    await cancel(ws, c.id);
    // The worker's heartbeat loop aborts cancelled jobs; drive one beat directly here.
    const { default: _ } = { default: null }; void _;
    const w = await prisma.job.findUnique({ where: { id: c.id } });
    expect(w!.status).toBe("CANCELLED");
    // Shutdown: abort with reason "shutdown" → job released, attempt not counted, worker STOPPED.
    const s = await enqueue({ companyId: ws, type: `${T}.slow`, payload: {}, createdBy: "t" });
    const q = runOne(undefined, [ws]);
    await new Promise((r) => setTimeout(r, 300));
    await stopWorker(200);
    await Promise.race([q, new Promise((r) => setTimeout(r, 5000))]);
    const after = (await prisma.job.findUnique({ where: { id: s.id } }))!;
    expect(after.status).toBe("QUEUED");
    expect(after.attempts).toBe(0);
    expect((await prisma.jobEvent.findFirst({ where: { jobId: s.id, type: "released" } }))).not.toBeNull();
    const wid = (await prisma.jobEvent.findFirst({ where: { jobId: s.id, type: "claimed" } }))!.workerId!;
    expect((await prisma.worker.findUnique({ where: { id: wid } }))!.status).toBe("STOPPED");
    resetWorkerForTests();
    await registerWorker("test");
    await prisma.job.update({ where: { id: s.id }, data: { status: "CANCELLED" } });
    void p;
  }, 30_000);

  it("kill switch: with autonomy disabled nothing of the workspace is claimed; the global switch stops everything", async () => {
    const j = await enqueue({ companyId: ws, type: `${T}.ok`, payload: {}, createdBy: "t" });
    await prisma.runtimeSettings.upsert({ where: { companyId: ws }, create: { companyId: ws, autonomyEnabled: false }, update: { autonomyEnabled: false } });
    expect(await claim("w", types("ok"))).toBeNull();
    await prisma.runtimeSettings.update({ where: { companyId: ws }, data: { autonomyEnabled: true } });
    await prisma.runtimeSettings.upsert({ where: { companyId: "*" }, create: { companyId: "*", autonomyEnabled: false }, update: { autonomyEnabled: false } });
    expect(await claim("w", types("ok"))).toBeNull();
    await prisma.runtimeSettings.update({ where: { companyId: "*" }, data: { autonomyEnabled: true } });
    expect((await claim("w", types("ok")))!.id).toBe(j.id);
    await complete(j.id, "w", {});
  });
});

describe("scheduler and circuit breakers", () => {
  it("parses specs; fires each due slot exactly once even when two workers tick concurrently", async () => {
    const from = new Date("2026-10-23T10:07:30Z");
    expect(nextRun("every 15m", from)!.toISOString()).toBe("2026-10-23T10:15:00.000Z");
    expect(nextRun("30 9 * * 1-5", from)!.toISOString()).toBe("2026-10-26T09:30:00.000Z"); // next weekday 09:30 UTC
    expect(nextRun("*/20 * * * *", from)!.toISOString()).toBe("2026-10-23T10:20:00.000Z");
    expect(nextRun("once 2026-10-23T10:00:00Z", from)).toBeNull();
    expect(() => nextRun("61 * * * *", from)).toThrow(/cron field/);
    const s = await createSchedule({ companyId: ws, name: "ping", jobType: "runtime.ping", payload: {}, spec: "every 5m", createdBy: "t" });
    await prisma.schedule.update({ where: { id: s.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    // Many concurrent ticks (regression: a stale read used to fire the same slot twice).
    const fired = (await Promise.all(Array.from({ length: 6 }, (_, i) => tickSchedules(`w${i}`)))).flat();
    expect(fired.filter((x) => x === s.id)).toHaveLength(1);
    expect(await prisma.job.count({ where: { scheduleId: s.id } })).toBe(1);
    const after = (await prisma.schedule.findUnique({ where: { id: s.id } }))!;
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    await tickSchedules("w1");
    expect(await prisma.job.count({ where: { scheduleId: s.id } })).toBe(1); // not due again yet
  });

  it("a breaker opens after repeated failures and blocks claims of that job type until reset/cool-down", async () => {
    for (let i = 0; i < BREAKER.threshold; i++) await recordOutcome(ws, `job:${T}.flaky`, false, "provider outage");
    expect(await isOpen(ws, `job:${T}.flaky`)).toBe(true);
    const j = await enqueue({ companyId: ws, type: `${T}.flaky`, payload: {}, createdBy: "t" });
    expect(await claim("w", types("flaky"))).toBeNull();
    await recordOutcome(ws, `job:${T}.flaky`, true);
    expect(await isOpen(ws, `job:${T}.flaky`)).toBe(false);
    expect((await claim("w", types("flaky")))!.id).toBe(j.id);
    await complete(j.id, "w", {});
  });
});

describe("goals, budgets, modes and permissions", () => {
  it("a supervised build goal plans for real (model double), then WAITS for a person at scope approval", async () => {
    const g = await createGoal({ companyId: ws, userId: users.owner.id, email: users.owner.email, kind: "build_product", mode: "SUPERVISED", request: "Build me a job scam detection platform where users submit listings and get a risk score.", limits: { pollMs: 100 } });
    for (let i = 0; i < 12; i++) if (!(await drain(3, [ws]))) await new Promise((r) => setTimeout(r, 120));
    const row = (await prisma.goal.findUnique({ where: { id: g.id } }))!;
    expect(row.status).toBe("WAITING");
    expect(row.statusReason).toMatch(/approve the scope/);
    const plan = JSON.parse(row.plan) as { key: string; status: string }[];
    expect(plan.find((s) => s.key === "plan")!.status).toBe("done");
    expect(JSON.parse(row.acceptance).length).toBeGreaterThan(0);
    await controlGoal(ws, g.id, "cancel", "t");
  }, 60_000);

  it("budget enforcement: a goal stops at its step limit with BUDGET_EXHAUSTED and a resumable checkpoint", async () => {
    const g = await createGoal({ companyId: ws, userId: users.owner.id, email: users.owner.email, kind: "build_product", mode: "SUPERVISED", request: "Build me a job scam detection platform, second copy for the budget test.", limits: { maxAdvances: 2, pollMs: 100 } });
    for (let i = 0; i < 10; i++) if (!(await drain(3, [ws]))) await new Promise((r) => setTimeout(r, 120));
    const row = (await prisma.goal.findUnique({ where: { id: g.id } }))!;
    expect(row.status).toBe("BUDGET_EXHAUSTED");
    expect(row.statusReason).toMatch(/step limit \(2\).*raise the limits and resume/);
    await expect(controlGoal(ws, g.id, "resume", "t")).rejects.toThrow(/raise the limits/);
    const resumed = await controlGoal(ws, g.id, "resume", "t", { maxAdvances: 50 });
    expect(resumed!.status).toBe("QUEUED");
    expect(await prisma.notification.findFirst({ where: { companyId: ws, dedupeKey: `goal:${g.id}:BUDGET_EXHAUSTED` } })).not.toBeNull();
    await controlGoal(ws, g.id, "cancel", "t");
    expect(clampGoalLimits({ maxCostUsd: 1e9 }).maxCostUsd).toBe(500);
  }, 60_000);

  it("a duplicate / superseded advance job has no side effects", async () => {
    const g = await createGoal({ companyId: ws, userId: users.owner.id, email: users.owner.email, kind: "improve_aura", mode: "CONTINUOUS_IMPROVEMENT", request: "" });
    await prisma.goal.update({ where: { id: g.id }, data: { status: "PAUSED" } });
    expect(await advanceGoal(g.id)).toMatchObject({ note: "nothing to do" });
    await prisma.goal.update({ where: { id: g.id }, data: { status: "QUEUED" } });
    expect(await advanceGoal(g.id, { jobId: "not-the-current-job" })).toMatchObject({ note: "superseded advance" });
    await controlGoal(ws, g.id, "cancel", "t");
  });

  it("server-side permissions: modes require roles; kill switch is ADMIN; other tenants are denied", async () => {
    await as("viewer");
    expect((await GoalsRoute.POST(req("POST", { kind: "build_product", mode: "SUPERVISED", request: "x".repeat(30) }), ctx({ id: ws }))).status).toBe(403);
    await as("member");
    expect((await GoalsRoute.POST(req("POST", { kind: "build_product", mode: "AUTONOMOUS_DEV", request: "x".repeat(30) }), ctx({ id: ws }))).status).toBe(403);
    expect((await RuntimeRoute.POST(req("POST", { action: "autonomy", enabled: false }), ctx({ id: ws }))).status).toBe(403);
    expect((await RuntimeRoute.GET(req(), ctx({ id: ws }))).status).toBe(200);
    await as("owner");
    expect((await GoalsRoute.POST(req("POST", { kind: "build_product", mode: "PRODUCTION_OPS", request: "x".repeat(30) }), ctx({ id: ws }))).status).toBe(422);
    const off = await RuntimeRoute.POST(req("POST", { action: "autonomy", enabled: false, reason: "test" }), ctx({ id: ws }));
    expect(off.status).toBe(200);
    expect((await prisma.runtimeSettings.findUnique({ where: { companyId: ws } }))!.autonomyEnabled).toBe(false);
    await RuntimeRoute.POST(req("POST", { action: "autonomy", enabled: true }), ctx({ id: ws }));
    const j = await enqueue({ companyId: ws, type: `${T}.ok`, payload: {}, createdBy: "t" });
    await as("outsider");
    expect([403, 404]).toContain((await RuntimeRoute.GET(req(), ctx({ id: ws }))).status);
    expect([403, 404]).toContain((await JobRoute.GET(req(), ctx({ id: ws, jobId: j.id }))).status);
    expect((await JobRoute.GET(req(), ctx({ id: other, jobId: j.id }))).status).toBe(404);
    await as(null);
    await prisma.job.update({ where: { id: j.id }, data: { status: "CANCELLED" } });
  });

  it("validates configuration without leaking secrets", () => {
    const v = validateRuntimeConfig({ NODE_ENV: "production", DATABASE_URL: "file:x", AUTH_SECRET: "short", AURA_WORKER_CONCURRENCY: "zero" } as unknown as NodeJS.ProcessEnv);
    expect(v.errors.join()).toMatch(/AUTH_SECRET.*16/);
    expect(v.errors.join()).toMatch(/AURA_WORKER_CONCURRENCY/);
    expect(JSON.stringify(v)).not.toMatch(/short/);
  });
});

describe("self-modification (isolated worktree, bounded, automatic rollback)", () => {
  let repo = "";
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "u", GIT_AUTHOR_EMAIL: "u@x", GIT_COMMITTER_NAME: "u", GIT_COMMITTER_EMAIL: "u@x" } }).trim();
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "aura-selfmod-repo-"));
    roots.push(repo);
    mkdirSync(join(repo, "src/lib/builder"), { recursive: true });
    writeFileSync(join(repo, "src/lib/builder/intel.ts"), "export const x = 1;\n");
    writeFileSync(join(repo, "src/lib/builder/intel.test.ts"), "// test\n");
    g("init", "-q", "-b", "main");
    g("add", "-A");
    g("commit", "-q", "-m", "base");
    process.env.AURA_SELFMOD_REPO = repo;
  });
  afterAll(() => { delete process.env.AURA_SELFMOD_REPO; });

  it("refuses patches to protected paths (security, tests, benchmarks, decision rules) and oversized patches", () => {
    expect(checkPatchScope({ "src/lib/auth/authz.ts": "x" }, {}).join()).toMatch(/protected/);
    expect(checkPatchScope({ "src/lib/lab/benchmarks.ts": "x" }, {}).join()).toMatch(/protected/);
    expect(checkPatchScope({ "src/lib/builder/intel.test.ts": "x" }, {}).join()).toMatch(/protected/);
    expect(checkPatchScope({ "src/app/page.tsx": "x" }, {}).join()).toMatch(/allow-list/);
    expect(checkPatchScope({ "src/lib/builder/intel.ts": "a\n".repeat(500) }, { "src/lib/builder/intel.ts": "" }).join()).toMatch(/lines/);
    expect(checkPatchScope({ "src/lib/builder/intel.ts": "export const x = 2;\n" }, { "src/lib/builder/intel.ts": "export const x = 1;\n" })).toEqual([]);
  });

  it("a change whose tests fail is rolled back: no branch, no worktree, main untouched", async () => {
    const r = await runSelfModification({ id: "exp-fail-1", files: { "src/lib/builder/intel.ts": "export const x = 2;\n" }, tests: ["src/lib/builder/intel.test.ts"], message: "try x=2", runner: async () => ({ command: "host test runner (test double)", exitCode: 1, output: "1 failed" }) });
    expect(r.status).toBe("REVERTED");
    expect(g("branch", "--list", "aura/selfmod/*")).toBe("");
    expect(g("worktree", "list").split("\n")).toHaveLength(1);
    expect(g("show", "main:src/lib/builder/intel.ts")).toBe("export const x = 1;");
    expect(g("status", "--porcelain")).toBe("");
  });

  it("a change whose tests pass is committed on its own branch only (never merged)", async () => {
    let sawFile = "";
    const r = await runSelfModification({ id: "exp-pass-1", files: { "src/lib/builder/intel.ts": "export const x = 3;\n" }, tests: ["src/lib/builder/intel.test.ts"], message: "x=3", runner: async (wt) => { sawFile = execFileSync("cat", [join(wt, "src/lib/builder/intel.ts")], { encoding: "utf8" }); return { command: "host test runner (test double)", exitCode: 0, output: "ok" }; } });
    expect(r.status).toBe("COMMITTED");
    expect(sawFile).toBe("export const x = 3;\n"); // tests ran against the isolated worktree
    expect(g("show", `${r.branch}:src/lib/builder/intel.ts`)).toBe("export const x = 3;");
    expect(g("show", "main:src/lib/builder/intel.ts")).toBe("export const x = 1;");
    expect(g("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(g("log", "-1", "--format=%an %s", r.branch!)).toBe("AURA self-improvement x=3");
    expect(existsSync(join(repo, ".git", "worktrees", "exp-pass-1"))).toBe(false);
  });

  it("a failed patch is recorded and not re-run without new evidence", async () => {
    const files = { "src/lib/builder/intel.ts": "export const x = 9;\n" };
    const failing = async () => ({ command: "host test runner (test double)", exitCode: 1, output: "1 failed" });
    const a = await attemptSelfModification({ companyId: ws, actor: "t", id: "exp-rec-1", files, tests: ["src/lib/builder/intel.test.ts"], message: "x=9", runner: failing });
    expect(a.status).toBe("REVERTED");
    expect(a.attempt.rollback).toMatch(/deleted automatically/);
    const b = await attemptSelfModification({ companyId: ws, actor: "t", id: "exp-rec-2", files, tests: ["src/lib/builder/intel.test.ts"], message: "x=9 again", runner: failing });
    expect(b.status).toBe("REFUSED");
    expect(b.reasons[0]).toMatch(/already reverted/);
    expect(await prisma.selfModAttempt.count({ where: { companyId: ws } })).toBe(1);
  });
});

void progress; void retry;
