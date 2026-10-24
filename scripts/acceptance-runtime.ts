/**
 * V6 end-to-end acceptance: a bounded coding goal executed by REAL worker
 * PROCESSES (`npm run worker`), interrupted by SIGKILL mid-goal, resumed by a
 * fresh worker process, verified from persisted evidence.
 *
 *   1. start the model provider endpoint (real ANTHROPIC_API_KEY if
 *      AURA_ACCEPTANCE_LIVE=1, else the HTTP test double — reported as such)
 *   2. submit an AUTONOMOUS_DEV build goal via the goal engine
 *   3. spawn worker #1; wait until the goal's engineering run is RUNNING
 *   4. SIGKILL worker #1 (no graceful shutdown — simulates a crash/redeploy)
 *   5. spawn worker #2; it reclaims the expired leases and continues
 *   6. wait for the goal to finish; check: goal COMPLETED, task VERIFIED,
 *      real artifact on the task branch, engine test run exit 0 in Docker,
 *      lease_reclaimed event, two distinct worker ids in the history
 *   7. stop worker #2 gracefully (SIGTERM); re-read everything from a fresh
 *      DB connection; history and final state unchanged
 *
 * Usage: DATABASE_URL=file:./accept.db npx tsx scripts/acceptance-runtime.ts
 * Exit code 0 = all checks passed; the report is printed as JSON.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const live = process.env.AURA_ACCEPTANCE_LIVE === "1";
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (live && !process.env.ANTHROPIC_API_KEY) throw new Error("AURA_ACCEPTANCE_LIVE=1 needs ANTHROPIC_API_KEY");
  const env: NodeJS.ProcessEnv = { ...process.env, AURA_GIT_ROOT: mkdtempSync(join(tmpdir(), "aura-acc-git-")), AURA_WORK_ROOT: mkdtempSync(join(tmpdir(), "aura-acc-work-")), AURA_JOB_LEASE_MS: "6000", AURA_SCHEDULER_TICK_MS: "2000", AURA_WORKER_CONCURRENCY: "2", AURA_JOB_BACKOFF_MS: "500", AURA_WORKER: "external" };
  let doubleClose: (() => Promise<void>) | null = null;
  if (!live) {
    const { startAnthropicDouble } = await import("../test/doubles/anthropic");
    const { scripted } = await import("../test/doubles/scamscout");
    const d = await startAnthropicDouble(scripted({ fixOnRepair: true }));
    env.ANTHROPIC_API_KEY = "acceptance-test-double";
    env.ANTHROPIC_BASE_URL = d.url;
    doubleClose = d.close;
  }
  Object.assign(process.env, env);
  const { prisma } = await import("@/lib/db");
  const { createCompany } = await import("@/lib/company/provision");
  const { createGoal } = await import("@/lib/runtime/goals");
  const { dockerAvailable } = await import("@/lib/sandbox/docker");
  if (!(await dockerAvailable())) throw new Error("Docker is required: the goal's tests run in the sandbox");

  const s = Date.now();
  const user = await prisma.user.create({ data: { email: `acc_${s}@aura.local`, name: "Acceptance" } });
  const ws = (await createCompany({ name: `ACCEPT-${s}`, mission: "m", industry: "Software", ownerId: user.id })).id;
  await prisma.subscription.create({ data: { companyId: ws, plan: "pro", status: "active" } });
  const goal = await createGoal({ companyId: ws, userId: user.id, email: user.email, kind: "build_product", mode: "AUTONOMOUS_DEV", request: "Build me a job scam detection platform where users can submit suspicious job listings and get a risk assessment.", limits: { pollMs: 1000, maxCostUsd: 2 } });
  console.log(`goal ${goal.id} in workspace ${ws} (${live ? "LIVE model provider" : "model provider TEST DOUBLE"})`);

  const spawnWorker = (n: number): ChildProcess => {
    // Spawn the worker process directly (not via npx, whose wrapper would absorb the kill signal),
    // in its own process group so SIGKILL reaches every process of that worker.
    const p = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/worker.ts"], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    p.stdout!.on("data", (b) => process.env.ACC_VERBOSE && process.stdout.write(`[w${n}] ${b}`));
    p.stderr!.on("data", (b) => process.env.ACC_VERBOSE && process.stderr.write(`[w${n}] ${b}`));
    return p;
  };

  // tsx re-executes node, so the worker row's pid is the child's; identify a worker by the row it registered after spawn.
  const workerAfter = async (t: Date) => {
    for (let i = 0; i < 60; i++) {
      const w = await prisma.worker.findFirst({ where: { startedAt: { gte: t } }, orderBy: { startedAt: "desc" } });
      if (w) return w.id;
      await sleep(250);
    }
    return null;
  };
  const t1 = new Date();
  const w1 = spawnWorker(1);
  const w1Id = await workerAfter(t1);
  let killedDuring = "";
  for (let i = 0; i < 240; i++) {
    const b = await prisma.build.findFirst({ where: { companyId: ws }, orderBy: { createdAt: "desc" } });
    // Kill while the engineering run is mid-flight (agent turn / sandbox verification), not before it starts.
    if (b?.status === "RUNNING" && ["implement", "verify", "review", "repair"].includes(b.phase)) { killedDuring = `build ${b.id} phase ${b.phase} attempt ${b.attempt}`; break; }
    await sleep(500);
  }
  check("worker #1 picked up the goal and started an engineering run", !!killedDuring, killedDuring || "no run started within 120 s");
  process.kill(-w1.pid!, "SIGKILL"); // whole process group: no graceful shutdown, no lease release
  await new Promise((r) => w1.once("exit", r));
  await sleep(300);
  const alive = (() => { try { process.kill(w1.pid!, 0); return true; } catch { return false; } })();
  check("worker #1 process is really gone", !alive, `pid ${w1.pid}`);
  check("worker #1 killed without graceful shutdown (row still RUNNING, heartbeat stops)", (await prisma.worker.findUnique({ where: { id: w1Id ?? "" } }))?.status === "RUNNING", w1Id ?? "no worker row");

  const t2 = new Date();
  const w2 = spawnWorker(2);
  const w2Id = await workerAfter(t2);
  let final = await prisma.goal.findUnique({ where: { id: goal.id } });
  for (let i = 0; i < 600 && final && !["COMPLETED", "FAILED", "BLOCKED", "BUDGET_EXHAUSTED", "CANCELLED"].includes(final.status); i++) {
    await sleep(1000);
    final = await prisma.goal.findUnique({ where: { id: goal.id } });
  }
  check("goal reached COMPLETED after the crash", final?.status === "COMPLETED", `${final?.status}: ${final?.statusReason.slice(0, 300)}`);
  const productId = JSON.parse(final!.checkpoint).productId as string;
  const item = await prisma.backlogItem.findFirst({ where: { productId, key: "E1.S1.T1" } });
  check("task VERIFIED from sandbox evidence", item?.status === "VERIFIED", `${item?.status} / ${item?.verification}`);
  const builds = await prisma.build.findMany({ where: { productId }, include: { commands: true }, orderBy: { createdAt: "asc" } });
  const verified = builds.find((b) => b.status === "VERIFIED");
  const lastTest = verified?.commands.filter((c) => c.actor === "engine" && c.purpose === "test").pop();
  check("engine test run in the Docker sandbox passed", lastTest?.exitCode === 0, lastTest ? `${lastTest.command} → exit ${lastTest.exitCode}` : "none");
  const product = await prisma.product.findUnique({ where: { id: productId } });
  const { readAt } = await import("@/lib/factory/git");
  const artifact = verified ? await readAt(ws, product!.repoId!, verified.branch, "src/routes/assessments.js") : null;
  check("real artifact committed on the task branch", !!artifact && /toLowerCase\(\)\.includes/.test(artifact), verified ? `${verified.branch} @ ${verified.headSha?.slice(0, 8)}` : "no verified build");
  const reclaimed = await prisma.jobEvent.count({ where: { companyId: ws, type: "lease_reclaimed" } });
  check("interrupted work was reclaimed from expired leases (durable event)", reclaimed > 0, `${reclaimed} lease_reclaimed event(s)`);
  const workerIds = new Set((await prisma.jobEvent.findMany({ where: { companyId: ws, type: "claimed" }, select: { workerId: true } })).map((e) => e.workerId));
  check("history shows both worker processes", workerIds.size >= 2, [...workerIds].join(", "));

  const snapshot = async (db: PrismaClient) => JSON.stringify({ goal: await db.goal.findUnique({ where: { id: goal.id }, select: { status: true, plan: true, acceptance: true, statusReason: true } }), jobs: await db.job.findMany({ where: { companyId: ws }, select: { id: true, status: true, attempts: true }, orderBy: { id: "asc" } }), events: await db.jobEvent.count({ where: { companyId: ws } }) });
  const before = await snapshot(prisma as unknown as PrismaClient);
  process.kill(-w2.pid!, "SIGTERM");
  await new Promise((r) => w2.once("exit", r));
  const fresh = new PrismaClient();
  const after = await snapshot(fresh);
  check("after restart/shutdown, history and final state are unchanged (fresh DB connection)", before === after, `${JSON.parse(after).events} events`);
  const w2Row = await fresh.worker.findUnique({ where: { id: w2Id ?? "" } });
  check("worker #2 shut down gracefully (STOPPED)", w2Row?.status === "STOPPED", w2Row?.status ?? "no row");
  await fresh.$disconnect();
  await prisma.$disconnect();
  await doubleClose?.();
  const report = { live, provider: live ? "anthropic (live)" : "HTTP test double — NOT proof of live provider integration", goalId: goal.id, workspace: ws, checks };
  console.log(JSON.stringify(report, null, 2));
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
