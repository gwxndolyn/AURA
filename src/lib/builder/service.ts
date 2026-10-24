/**
 * Build lifecycle API used by the product scheduler and routes: start a run
 * for a backlog task (quota-checked, idempotent per task attempt chain),
 * cancel it, retry it, and read it.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { enqueue, cancel as cancelJob, retry as retryJob } from "@/lib/jobs/queue";
import { killSandbox } from "@/lib/sandbox/docker";
import { assertCanStart, recordUsage } from "@/lib/billing/entitlements";
import { log } from "@/lib/observability/log";

export const BUILD_JOB = "build.run";

export function branchFor(itemKey: string) {
  return `aura/${itemKey.toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`;
}

export async function startBuild(args: { companyId: string; productId: string; itemKey: string; actor: string; maxRepairs: number; budgetUsd?: number; correlationId?: string }) {
  const open = await prisma.build.findFirst({ where: { companyId: args.companyId, productId: args.productId, itemKey: args.itemKey, status: { in: ["QUEUED", "RUNNING"] } } });
  if (open) return open; // idempotent: never two runs for the same task
  await assertCanStart(args.companyId, "build");
  const correlationId = args.correlationId ?? randomUUID();
  const b = await prisma.build.create({ data: { companyId: args.companyId, productId: args.productId, itemKey: args.itemKey, branch: branchFor(args.itemKey), maxRepairs: Math.min(Math.max(args.maxRepairs, 0), 5), budgetUsd: Math.min(Math.max(args.budgetUsd ?? 1, 0.01), 10), correlationId, createdBy: args.actor } });
  const job = await enqueue({ companyId: args.companyId, type: BUILD_JOB, payload: { buildId: b.id }, dedupeKey: `build:${b.id}`, maxAttempts: 3, createdBy: args.actor, correlationId });
  await prisma.build.update({ where: { id: b.id }, data: { jobId: job.id } });
  await recordUsage(args.companyId, [{ metric: "build", quantity: 1 }], `build:${b.id}`);
  log("info", "build.queued", { buildId: b.id, productId: args.productId, itemKey: args.itemKey, correlationId });
  return { ...b, jobId: job.id };
}

export async function loadBuild(companyId: string, buildId: string) {
  const b = await prisma.build.findFirst({ where: { id: buildId, companyId }, include: { commands: { orderBy: { createdAt: "asc" }, select: { id: true, purpose: true, actor: true, command: true, network: true, exitCode: true, timedOut: true, durationMs: true, truncated: true, createdAt: true } } } });
  if (!b) throw new ApiError("Run not found", 404);
  return b;
}

export async function cancelBuild(companyId: string, buildId: string) {
  const b = await loadBuild(companyId, buildId);
  if (!["QUEUED", "RUNNING"].includes(b.status)) throw new ApiError(`Run is already ${b.status.toLowerCase()}`, 409);
  await prisma.build.update({ where: { id: b.id }, data: { status: "CANCELLED", phase: "done", finishedAt: new Date(), failure: "Cancelled by the user" } });
  if (b.jobId) await cancelJob(companyId, b.jobId);
  // Propagate to the sandbox: the container executing right now (if any) is killed; the model loop stops at its next turn check.
  const fresh = await prisma.build.findUnique({ where: { id: b.id }, select: { container: true } });
  const killed = fresh?.container ? await killSandbox(fresh.container).catch(() => false) : false;
  return { status: "CANCELLED", killedContainer: killed ? fresh!.container : null, note: b.status === "RUNNING" ? (killed ? "The running sandbox command was stopped; nothing further runs and nothing is committed." : "Nothing further runs and nothing is committed; an agent turn in flight stops at its next check.") : undefined };
}

/**
 * Crash recovery: a run marked QUEUED/RUNNING whose job is gone or finished
 * (worker died after the job was finalised, DB restored, job deleted) would
 * otherwise look "running" forever. It is moved to BLOCKED with the reason;
 * Retry re-queues it. Runs whose job is still alive are left alone — an
 * expired job lease is reclaimed by the queue itself.
 */
export async function recoverOrphanedBuilds(companyId: string, productId?: string) {
  const open = await prisma.build.findMany({ where: { companyId, ...(productId ? { productId } : {}), status: { in: ["QUEUED", "RUNNING"] }, itemKey: { not: "RELEASE" } } });
  const recovered: string[] = [];
  for (const b of open) {
    const job = b.jobId ? await prisma.job.findFirst({ where: { id: b.jobId, companyId } }) : null;
    if (job && ["QUEUED", "RUNNING"].includes(job.status)) continue;
    const why = !job ? "its job record is missing" : `its job ended as ${job.status.toLowerCase()}${job.lastError ? `: ${job.lastError.slice(0, 200)}` : ""}`;
    const r = await prisma.build.updateMany({ where: { id: b.id, status: b.status }, data: { status: "BLOCKED", phase: "done", container: null, failure: `Recovered after an interruption: the run was still marked ${b.status.toLowerCase()} but ${why}. Retry to run it again.`, finishedAt: new Date() } });
    if (r.count) recovered.push(b.id);
  }
  if (recovered.length) log("warn", "build.recovered_orphans", { companyId, productId, recovered });
  return recovered;
}

/** Recovery path for BLOCKED (e.g. provider/sandbox unavailable) runs: re-queue the same run. */
export async function retryBuild(companyId: string, buildId: string) {
  const b = await loadBuild(companyId, buildId);
  if (!["BLOCKED", "FAILED", "CANCELLED"].includes(b.status)) throw new ApiError(`Run is ${b.status.toLowerCase()}`, 409);
  await assertCanStart(companyId, "build");
  await prisma.build.update({ where: { id: b.id }, data: { status: "QUEUED", phase: "queued", failure: "", finishedAt: null, attempt: b.status === "FAILED" ? 0 : b.attempt } });
  if (b.jobId && (await retryJob(companyId, b.jobId))) return { status: "QUEUED" };
  const job = await enqueue({ companyId, type: BUILD_JOB, payload: { buildId: b.id }, dedupeKey: `build:${b.id}:retry:${Date.now()}`, createdBy: "retry", correlationId: b.correlationId });
  await prisma.build.update({ where: { id: b.id }, data: { jobId: job.id } });
  return { status: "QUEUED" };
}
