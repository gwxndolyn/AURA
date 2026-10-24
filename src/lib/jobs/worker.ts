/**
 * Job worker. Runs inside the Next.js server process (instrumentation.ts,
 * AURA_WORKER=inline — default for single-node) or as a separate process
 * (`npm run worker`, AURA_WORKER=external on the web servers). Several workers
 * may run concurrently: claims are leased, so each job executes on exactly
 * one worker at a time.
 *
 * Lifecycle (V6):
 *  - registers a Worker row and heart-beats it (`heartbeatAt`) together with
 *    the leases of the jobs it runs; the control plane shows a worker as
 *    offline when its heartbeat is older than WORKER_STALE_MS
 *  - each job gets an AbortSignal: aborted on cancel, on its timeoutMs, and
 *    on shutdown; handlers must stop at the next checkpoint
 *  - per-job-type circuit breakers record outcomes (src/lib/runtime/breaker.ts)
 *  - one scheduler pass per loop period (src/lib/runtime/schedule.ts)
 *  - SIGTERM/SIGINT: stop claiming, give running jobs `AURA_SHUTDOWN_GRACE_MS`
 *    to finish, then release them back to the queue (attempt not counted) and
 *    mark the worker STOPPED. A killed process (no signal) is recovered by
 *    lease expiry instead.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { prisma } from "@/lib/db";
import { claim, complete, fail, heartbeat, release, isCancelled, JobError, LEASE_MS, jobEvent } from "./queue";
import { HANDLERS, type JobContext } from "./registry";
import { ProviderError } from "@/lib/ai/claude";
import { log } from "@/lib/observability/log";
import { recordOutcome, halfOpenDue } from "@/lib/runtime/breaker";
import { tickSchedules } from "@/lib/runtime/schedule";

const CONCURRENCY = Math.min(Math.max(Number(process.env.AURA_WORKER_CONCURRENCY || 2), 1), 8);
export const WORKER_STALE_MS = Number(process.env.AURA_WORKER_STALE_MS || 60_000);
const HEARTBEAT_MS = Math.min(15_000, Math.floor(LEASE_MS / 3));

interface Running { jobId: string; abort: AbortController; done: Promise<unknown> }
const running = new Map<string, Running>();
let workerId: string | null = null;
let stopping = false;

export function currentWorkerId() {
  return workerId;
}

export async function registerWorker(mode: "inline" | "standalone" | "test", concurrency = CONCURRENCY) {
  const id = `w-${hostname().slice(0, 20)}-${process.pid}-${randomUUID().slice(0, 6)}`;
  await prisma.worker.create({ data: { id, host: hostname(), pid: process.pid, mode, version: process.env.AURA_CODE_VERSION || process.env.npm_package_version || "", concurrency } });
  workerId = id;
  return id;
}

async function beat() {
  if (!workerId) return;
  await prisma.worker.update({ where: { id: workerId }, data: { heartbeatAt: new Date(), running: JSON.stringify([...running.keys()]), status: stopping ? "DRAINING" : "RUNNING" } }).catch(() => null);
  for (const r of running.values()) {
    const held = await heartbeat(r.jobId, workerId).catch(() => false);
    if (!held || (await isCancelled(r.jobId).catch(() => false))) r.abort.abort(new Error(held ? "cancelled" : "lease lost"));
  }
}

/** Run one claimed job to completion (or failure). Exported for tests. */
const SCOPE = process.env.AURA_WORKER_COMPANIES ? process.env.AURA_WORKER_COMPANIES.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

export async function runOne(worker = workerId ?? `w-adhoc-${randomUUID().slice(0, 8)}`, companyIds: string[] | undefined = SCOPE): Promise<boolean> {
  if (stopping) return false;
  const job = await claim(worker, Object.keys(HANDLERS), companyIds);
  if (!job) return false;
  const handler = HANDLERS[job.type];
  const abort = new AbortController();
  const timer = job.timeoutMs ? setTimeout(() => abort.abort(new Error(`timed out after ${job.timeoutMs} ms`)), job.timeoutMs) : null;
  const ownBeat = workerId ? null : setInterval(() => void heartbeat(job.id, worker), HEARTBEAT_MS);
  const started = Date.now();
  log("info", "job.started", { jobId: job.id, type: job.type, attempt: job.attempts, worker, correlationId: job.correlationId });
  const ctx: JobContext = { signal: abort.signal, workerId: worker };
  const done = (async () => {
    try {
      const result = await handler(job, ctx);
      if (abort.signal.aborted) throw abort.signal.reason ?? new Error("aborted");
      await complete(job.id, worker, result);
      await recordOutcome(job.companyId, `job:${job.type}`, true);
      if (workerId) await prisma.worker.update({ where: { id: workerId }, data: { processed: { increment: 1 } } }).catch(() => null);
      log("info", "job.succeeded", { jobId: job.id, type: job.type, ms: Date.now() - started, correlationId: job.correlationId });
    } catch (e) {
      const reason = abort.signal.aborted ? String((abort.signal.reason as Error)?.message ?? "") : "";
      if (reason === "shutdown") {
        await release(job.id, worker, "worker shutting down; job returned to the queue");
        return;
      }
      if (reason === "cancelled" || (await isCancelled(job.id))) return; // already CANCELLED by the user
      const timedOut = reason.startsWith("timed out");
      const err = timedOut
        ? { message: `Job ${reason}`, retryable: true, kind: "timeout" }
        : e instanceof ProviderError
          ? { message: e.message, retryable: e.retryable, kind: `provider_${e.kind}` }
          : e instanceof JobError
            ? { message: e.message, retryable: e.retryable, kind: e.kind }
            : // Domain errors (e.g. PlanningOutputError) carry retryable/kind without extending JobError.
              { message: (e as Error).message ?? String(e), retryable: (e as { retryable?: unknown }).retryable === true, kind: typeof (e as { kind?: unknown }).kind === "string" ? (e as { kind: string }).kind : "internal" };
      if (timedOut) await jobEvent(job, "timeout", reason, {}, worker);
      await fail(job.id, worker, err);
      // Breakers count infrastructure/provider-type failures, not a task's own verdict (e.g. "not verified").
      if (!["cancelled", "budget", "not_verified"].includes(err.kind)) await recordOutcome(job.companyId, `job:${job.type}`, false, err.message);
      if (e instanceof ProviderError) await recordOutcome(job.companyId, "provider:anthropic", false, e.message);
      if (workerId) await prisma.worker.update({ where: { id: workerId }, data: { failed: { increment: 1 } } }).catch(() => null);
    } finally {
      if (timer) clearTimeout(timer);
      if (ownBeat) clearInterval(ownBeat);
      running.delete(job.id);
    }
  })();
  running.set(job.id, { jobId: job.id, abort, done });
  await done;
  return true;
}

let started = false;
/** Start the polling loop (idempotent per process). Returns a stop function for graceful shutdown. */
export function startWorker(mode: "inline" | "standalone" = "inline") {
  if (started) return stopWorker;
  started = true;
  void (async () => {
    const id = await registerWorker(mode);
    log("info", "worker.started", { worker: id, mode, concurrency: CONCURRENCY });
    const hb = setInterval(() => void beat(), HEARTBEAT_MS);
    const sched = setInterval(() => {
      if (stopping) return;
      void tickSchedules(id).catch((e) => log("error", "scheduler.tick_failed", { error: (e as Error).message }));
      void halfOpenDue().catch(() => null);
    }, Number(process.env.AURA_SCHEDULER_TICK_MS || 15_000));
    hb.unref?.();
    sched.unref?.();
    for (let i = 0; i < CONCURRENCY; i++) {
      void (async () => {
        while (!stopping) {
          let worked = false;
          try {
            worked = await runOne(id);
          } catch (e) {
            log("error", "worker.loop_error", { worker: id, error: (e as Error).message });
          }
          await new Promise((r) => setTimeout(r, worked ? 50 : 1500));
        }
      })();
    }
  })();
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void stopWorker().finally(() => mode === "standalone" && process.exit(0)));
  return stopWorker;
}

/**
 * Graceful shutdown: stop claiming; wait up to the grace period for running
 * jobs; abort the rest with reason "shutdown" (they are released back to the
 * queue); mark the worker STOPPED.
 */
export async function stopWorker(graceMs = Number(process.env.AURA_SHUTDOWN_GRACE_MS || 20_000)) {
  stopping = true;
  log("info", "worker.stopping", { worker: workerId, running: running.size });
  if (workerId) await prisma.worker.update({ where: { id: workerId }, data: { status: "DRAINING" } }).catch(() => null);
  const all = [...running.values()];
  await Promise.race([Promise.allSettled(all.map((r) => r.done)), new Promise((r) => setTimeout(r, graceMs))]);
  for (const r of running.values()) r.abort.abort(new Error("shutdown"));
  await Promise.allSettled([...running.values()].map((r) => r.done));
  if (workerId) await prisma.worker.update({ where: { id: workerId }, data: { status: "STOPPED", stoppedAt: new Date(), running: "[]" } }).catch(() => null);
  log("info", "worker.stopped", { worker: workerId });
}

/** Test helper: reset module state so a test can simulate a fresh process. */
export function resetWorkerForTests() {
  stopping = false;
  started = false;
  workerId = null;
  running.clear();
}

/** Drain the queue in-process (tests): run until no job is due. Pass companyIds to only run your own jobs. */
export async function drain(max = 50, companyIds?: string[]) {
  let n = 0;
  while (n < max && (await runOne(workerId ?? "drain", companyIds ?? SCOPE))) n++;
  return n;
}
