/**
 * Durable job queue on the primary database (extended in V6; same API).
 *
 * - enqueue() is idempotent per (companyId, dedupeKey).
 * - claim() takes a lease with compare-and-set. A job is eligible when it is
 *   QUEUED and due (or RUNNING with an expired lease: its worker died), its
 *   dependencies SUCCEEDED, its workspace's autonomy switch is on (and the
 *   global one), its job type's circuit breaker is not OPEN, and the
 *   workspace / concurrency-key limits leave room. Order: priority, then runAt.
 * - A job past its deadline is FAILED (deadline_missed) instead of starting.
 * - Failures retry with exponential backoff (+ jitter) only when retryable;
 *   otherwise, or after maxAttempts, the job is FAILED / DEAD.
 * - cancel() stops queued jobs immediately and asks running ones to stop at
 *   their next checkpoint (handlers poll isCancelled() / ctx.signal).
 * - Every transition is appended to JobEvent (durable history). progress()
 *   and saveCheckpoint() persist a handler's position so a retried or
 *   reclaimed attempt resumes from the last verified step.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { log } from "@/lib/observability/log";

export const LEASE_MS = Number(process.env.AURA_JOB_LEASE_MS || 120_000);

export class JobError extends Error {
  constructor(message: string, public retryable = false, public kind = "job_failed") {
    super(message);
    this.name = "JobError";
  }
}

export async function jobEvent(job: { id: string; companyId: string; attempts?: number }, type: string, detail = "", data: Record<string, unknown> = {}, workerId?: string | null) {
  await prisma.jobEvent.create({ data: { jobId: job.id, companyId: job.companyId, type, attempt: job.attempts ?? 0, detail: detail.slice(0, 2000), data: JSON.stringify(data).slice(0, 8000), workerId: workerId ?? null } }).catch(() => null);
}

export interface EnqueueInput {
  companyId: string; type: string; payload: Record<string, unknown>; dedupeKey?: string; maxAttempts?: number; createdBy: string; correlationId?: string; runAt?: Date;
  priority?: number; dependsOn?: string[]; deadline?: Date; timeoutMs?: number; concurrencyKey?: string; goalId?: string; scheduleId?: string;
}

export async function enqueue(input: EnqueueInput) {
  const data = {
    companyId: input.companyId,
    type: input.type,
    payload: JSON.stringify(input.payload),
    dedupeKey: input.dedupeKey ?? null,
    maxAttempts: Math.min(Math.max(input.maxAttempts ?? 3, 1), 10),
    createdBy: input.createdBy,
    correlationId: input.correlationId ?? randomUUID(),
    runAt: input.runAt ?? new Date(),
    priority: Math.min(Math.max(Math.round(input.priority ?? 100), 0), 1000),
    dependsOn: JSON.stringify(input.dependsOn ?? []),
    deadline: input.deadline ?? null,
    timeoutMs: input.timeoutMs ? Math.min(Math.max(input.timeoutMs, 1000), 6 * 3600_000) : null,
    concurrencyKey: input.concurrencyKey ?? null,
    goalId: input.goalId ?? null,
    scheduleId: input.scheduleId ?? null,
  };
  const create = async () => {
    const j = await prisma.job.create({ data });
    await jobEvent(j, "enqueued", `${j.type} by ${j.createdBy}`, { priority: j.priority, dependsOn: input.dependsOn ?? [], runAt: j.runAt });
    return j;
  };
  if (!input.dedupeKey) return create();
  const existing = await prisma.job.findFirst({ where: { companyId: input.companyId, dedupeKey: input.dedupeKey } });
  if (existing) return existing;
  try {
    return await create();
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
    return (await prisma.job.findFirst({ where: { companyId: input.companyId, dedupeKey: input.dedupeKey } }))!;
  }
}

// ---------------------------------------------------------------------------
// Eligibility helpers (kept here so claim() is the single choke point)
// ---------------------------------------------------------------------------

export interface RuntimeLimits { maxConcurrentJobs: number; maxConcurrentPerKey: number }
export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = { maxConcurrentJobs: 4, maxConcurrentPerKey: 1 };

async function settingsFor(companyIds: string[]) {
  const rows = await prisma.runtimeSettings.findMany({ where: { companyId: { in: [...companyIds, "*"] } } });
  const global = rows.find((r) => r.companyId === "*");
  return {
    globalOff: global ? !global.autonomyEnabled : false,
    of: (id: string) => {
      const r = rows.find((x) => x.companyId === id);
      return { enabled: r ? r.autonomyEnabled : true, limits: { ...DEFAULT_RUNTIME_LIMITS, ...parseJSON<Partial<RuntimeLimits>>(global?.limits, {}), ...parseJSON<Partial<RuntimeLimits>>(r?.limits, {}) } };
    },
  };
}

/**
 * Claim the next eligible job (optionally of given types / one workspace). Returns null when idle.
 * `companyIds` scopes a worker to specific workspaces (tests running in parallel share one database and
 * must not execute each other's jobs with their own provider doubles; also usable for dedicated workers).
 */
export async function claim(worker: string, types?: string[], companyIds?: string[]) {
  const now = new Date();
  // Deadlines: queued work that can no longer start in time fails honestly.
  const missed = await prisma.job.findMany({ where: { status: "QUEUED", deadline: { lt: now } }, take: 20 });
  for (const m of missed) {
    const r = await prisma.job.updateMany({ where: { id: m.id, status: "QUEUED" }, data: { status: "FAILED", errorKind: "deadline_missed", lastError: `Deadline ${m.deadline!.toISOString()} passed before the job could start`, finishedAt: now } });
    if (r.count) await jobEvent(m, "deadline_missed", m.deadline!.toISOString());
  }
  const candidates = await prisma.job.findMany({
    where: {
      ...(types ? { type: { in: types } } : {}),
      ...(companyIds ? { companyId: { in: companyIds } } : {}),
      OR: [{ status: "QUEUED", runAt: { lte: now } }, { status: "RUNNING", leaseUntil: { lt: now } }],
    },
    orderBy: [{ priority: "asc" }, { runAt: "asc" }],
    take: 25,
  });
  if (!candidates.length) return null;
  const st = await settingsFor([...new Set(candidates.map((c) => c.companyId))]);
  if (st.globalOff) return null;
  const breakers = await prisma.circuitBreaker.findMany({ where: { companyId: { in: [...new Set(candidates.map((c) => c.companyId))] }, state: "OPEN" } });
  for (const c of candidates) {
    const s = st.of(c.companyId);
    if (!s.enabled) continue;
    const br = breakers.find((b) => b.companyId === c.companyId && b.scope === `job:${c.type}` && (!b.reopenAt || b.reopenAt > now));
    if (br) continue;
    const deps = parseJSON<string[]>(c.dependsOn, []);
    if (deps.length) {
      const depRows = await prisma.job.findMany({ where: { id: { in: deps } }, select: { id: true, status: true } });
      const failedDep = depRows.find((d) => ["FAILED", "DEAD", "CANCELLED"].includes(d.status));
      if (failedDep || depRows.length < deps.length) {
        const r = await prisma.job.updateMany({ where: { id: c.id, status: "QUEUED" }, data: { status: "FAILED", errorKind: "dependency_failed", lastError: failedDep ? `Dependency ${failedDep.id} ended ${failedDep.status.toLowerCase()}` : "A dependency no longer exists", finishedAt: now } });
        if (r.count) await jobEvent(c, "failed", "dependency failed", { dependency: failedDep?.id });
        continue;
      }
      if (!depRows.every((d) => d.status === "SUCCEEDED")) continue;
    }
    const running = await prisma.job.count({ where: { companyId: c.companyId, status: "RUNNING", leaseUntil: { gte: now }, id: { not: c.id } } });
    if (running >= s.limits.maxConcurrentJobs) continue;
    if (c.concurrencyKey && (await prisma.job.count({ where: { concurrencyKey: c.concurrencyKey, status: "RUNNING", leaseUntil: { gte: now }, id: { not: c.id } } })) >= s.limits.maxConcurrentPerKey) continue;
    const lease = c.timeoutMs ? Math.max(LEASE_MS, Math.min(c.timeoutMs + 30_000, LEASE_MS * 4)) : LEASE_MS;
    const r = await prisma.job.updateMany({
      where: { id: c.id, status: c.status, OR: [{ leaseUntil: null }, { leaseUntil: c.leaseUntil }] },
      data: { status: "RUNNING", leaseOwner: worker, workerId: worker, leaseUntil: new Date(now.getTime() + lease), attempts: { increment: 1 }, startedAt: c.startedAt ?? now },
    });
    if (r.count === 1) {
      const job = (await prisma.job.findUnique({ where: { id: c.id } }))!;
      if (c.status === "RUNNING") {
        log("warn", "job.lease_expired_reclaimed", { jobId: job.id, type: job.type, previousOwner: c.leaseOwner, correlationId: job.correlationId });
        await jobEvent(job, "lease_reclaimed", `previous worker ${c.leaseOwner} stopped heart-beating`, { previousOwner: c.leaseOwner, checkpoint: parseJSON(job.checkpoint, {}) }, worker);
      }
      await jobEvent(job, "claimed", `attempt ${job.attempts}/${job.maxAttempts}`, {}, worker);
      return job;
    }
  }
  return null;
}

export async function heartbeat(jobId: string, worker: string) {
  const j = await prisma.job.findUnique({ where: { id: jobId }, select: { timeoutMs: true } });
  const lease = j?.timeoutMs ? Math.max(LEASE_MS, Math.min(j.timeoutMs + 30_000, LEASE_MS * 4)) : LEASE_MS;
  const r = await prisma.job.updateMany({ where: { id: jobId, leaseOwner: worker, status: "RUNNING" }, data: { leaseUntil: new Date(Date.now() + lease) } });
  return r.count === 1;
}

export async function complete(jobId: string, worker: string, result: unknown) {
  const r = await prisma.job.updateMany({ where: { id: jobId, leaseOwner: worker, status: "RUNNING" }, data: { status: "SUCCEEDED", result: JSON.stringify(result ?? {}).slice(0, 20_000), finishedAt: new Date(), leaseUntil: null, lastError: "", errorKind: null } });
  if (r.count) {
    const j = (await prisma.job.findUnique({ where: { id: jobId } }))!;
    await jobEvent(j, "succeeded", "", { result: result ?? {} }, worker);
  }
  return r.count === 1;
}

export function backoffMs(attempt: number, base = Number(process.env.AURA_JOB_BACKOFF_MS || 5_000), cap = 600_000, rand = Math.random) {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.8 + 0.4 * rand())); // ±20 % jitter so retries of many jobs do not align
}

export async function fail(jobId: string, worker: string, err: { message: string; retryable: boolean; kind: string; retryAfterMs?: number }) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.leaseOwner !== worker) return;
  if (job.status === "CANCELLED") return;
  const retry = err.retryable && job.attempts < job.maxAttempts;
  const wait = err.retryAfterMs ?? backoffMs(job.attempts);
  await prisma.job.update({
    where: { id: jobId },
    data: retry
      ? { status: "QUEUED", runAt: new Date(Date.now() + wait), leaseOwner: null, leaseUntil: null, lastError: err.message.slice(0, 2000), errorKind: err.kind }
      : { status: job.attempts >= job.maxAttempts && err.retryable ? "DEAD" : "FAILED", finishedAt: new Date(), leaseUntil: null, lastError: err.message.slice(0, 2000), errorKind: err.kind },
  });
  await jobEvent(job, retry ? "retry_scheduled" : job.attempts >= job.maxAttempts && err.retryable ? "dead" : "failed", err.message, { kind: err.kind, retryInMs: retry ? wait : undefined }, worker);
  log(retry ? "warn" : "error", retry ? "job.retry_scheduled" : "job.failed", { jobId, type: job.type, attempt: job.attempts, kind: err.kind, error: err.message.slice(0, 300), correlationId: job.correlationId });
}

/** Release a claimed job back to the queue without counting the attempt (graceful shutdown). */
export async function release(jobId: string, worker: string, reason: string) {
  const j = await prisma.job.findUnique({ where: { id: jobId }, select: { companyId: true } });
  const r = await prisma.job.updateMany({ where: { id: jobId, leaseOwner: worker, status: "RUNNING" }, data: { status: "QUEUED", leaseOwner: null, leaseUntil: null, runAt: new Date(), attempts: { decrement: 1 } } });
  if (r.count && j) await jobEvent({ id: jobId, companyId: j.companyId }, "released", reason, {}, worker);
  return r.count === 1;
}

export async function cancel(companyId: string, jobId: string) {
  const r = await prisma.job.updateMany({ where: { id: jobId, companyId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", finishedAt: new Date() } });
  if (r.count) await jobEvent({ id: jobId, companyId }, "cancelled", "");
  return r.count === 1;
}

export async function isCancelled(jobId: string) {
  const j = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
  return !j || j.status === "CANCELLED";
}

/** Retry a FAILED/DEAD/CANCELLED job (customer recovery path). Same job row, attempts reset, checkpoint kept. */
export async function retry(companyId: string, jobId: string) {
  const r = await prisma.job.updateMany({ where: { id: jobId, companyId, status: { in: ["FAILED", "DEAD", "CANCELLED"] } }, data: { status: "QUEUED", attempts: 0, runAt: new Date(), lastError: "", errorKind: null, finishedAt: null, leaseOwner: null, leaseUntil: null } });
  if (r.count) await jobEvent({ id: jobId, companyId }, "resumed", "retried by a person; resumes from the last checkpoint");
  return r.count === 1;
}

/** Persist progress (visible in the control plane). */
export async function progress(job: { id: string; companyId: string; attempts?: number }, step: string, message = "", pct?: number) {
  await prisma.job.update({ where: { id: job.id }, data: { progress: JSON.stringify({ step, message: message.slice(0, 500), pct: pct ?? null, at: new Date().toISOString() }) } }).catch(() => null);
  await jobEvent(job, "progress", `${step}${message ? `: ${message}` : ""}`, { step, pct });
}

/** Persist the last VERIFIED step so a later attempt resumes from it (handlers decide what is safe to skip). */
export async function saveCheckpoint(job: { id: string; companyId: string; attempts?: number }, state: Record<string, unknown>) {
  await prisma.job.update({ where: { id: job.id }, data: { checkpoint: JSON.stringify(state) } });
  await jobEvent(job, "checkpoint", String(state.step ?? ""), state);
}

export const payloadOf = <T>(job: { payload: string }) => parseJSON<T>(job.payload, {} as T);
export const checkpointOf = <T>(job: { checkpoint: string }) => parseJSON<T>(job.checkpoint, {} as T);
