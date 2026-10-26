/** Job type → handler. Handlers must be idempotent: a job may run again after a crash. */
import type { Job } from "@prisma/client";
import { prisma } from "@/lib/db";
import { payloadOf } from "./queue";
import { runBuild } from "@/lib/builder/engine";
import { settle } from "@/lib/billing/entitlements";
import { emit as emitLearning, processPending } from "@/lib/learning/service";
import { runCycle as runMaintenanceCycle } from "@/lib/factory/maintenance";
import { runPlanning } from "@/lib/factory/planning";
import { runExperiment as runLabExperiment } from "@/lib/lab/lab";
import { advanceGoal, createGoal, type GoalKind, type GoalMode, type GoalLimits } from "@/lib/runtime/goals";
import { runImprovementCycle } from "@/lib/runtime/improve";
import { runDeployment } from "@/lib/deploy/service";
import { runChangeRequest } from "@/lib/factory/change";
import { runAudit as runExperienceAudit } from "@/lib/experience/service";

/** Execution context: `signal` aborts on cancel / timeout / shutdown — long handlers must stop at their next checkpoint. */
export interface JobContext { signal: AbortSignal; workerId: string }
export type Handler = (job: Job, ctx: JobContext) => Promise<unknown>;

/** When a retryable failure has used its last attempt, leave the domain record in an honest terminal state. */
async function onFinalFailure<T>(job: Job, fn: () => Promise<T>, finalize: (message: string) => Promise<void>) {
  try {
    return await fn();
  } catch (e) {
    const err = e as { retryable?: boolean; message?: string };
    if (!err.retryable || job.attempts >= job.maxAttempts) await finalize(err.message ?? "failed");
    throw e;
  }
}

export const HANDLERS: Record<string, Handler> = {
  "build.run": async (job) => {
    const { buildId } = payloadOf<{ buildId: string }>(job);
    return onFinalFailure(job, () => runBuild(buildId, job.id), async (message) => {
      await prisma.build.updateMany({ where: { id: buildId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "BLOCKED", phase: "done", failure: `Stopped after ${job.attempts} attempt(s): ${message}`.slice(0, 2000), finishedAt: new Date() } });
      await settle(`build:${buildId}`, "concurrent_build", null);
      const fb = await prisma.build.findUnique({ where: { id: buildId }, select: { companyId: true, productId: true, itemKey: true, status: true } });
      if (fb) await emitLearning({ companyId: fb.companyId, type: "build.finished", key: `finished:${buildId}:${fb.status}`, productId: fb.productId, buildId, itemKey: fb.itemKey });
    });
  },
  // Lab experiments are long and deterministic; a failure leaves the experiment INTERRUPTED (re-runnable).
  "lab.experiment": async (job) => {
    const { experimentId, actor } = payloadOf<{ experimentId: string; actor: string }>(job);
    const r = await runLabExperiment(job.companyId, experimentId, actor);
    return { outcome: r.decision.outcome };
  },
  // One bounded step of an autonomous goal; schedules its own successor (durable, resumable).
  "goal.advance": async (job, ctx) => {
    const { goalId } = payloadOf<{ goalId: string }>(job);
    return advanceGoal(goalId, { signal: ctx.signal, jobId: job.id });
  },
  // Scheduled self-improvement cycle (create a Schedule with jobType "lab.cycle").
  "lab.cycle": async (job, ctx) => {
    const r = await runImprovementCycle(job.companyId, { actor: job.createdBy, signal: ctx.signal });
    return { experimentId: r.experimentId, summary: r.summary };
  },
  // A scheduled goal submission (POST goals {schedule}); the submitter's role was checked when scheduling.
  "goal.submit": async (job) => {
    const p = payloadOf<{ kind: GoalKind; mode: GoalMode; request: string; title?: string; productId?: string; limits?: Partial<GoalLimits>; userId: string; email: string }>(job);
    const g = await createGoal({ companyId: job.companyId, userId: p.userId, email: p.email, kind: p.kind, mode: p.mode, request: p.request, title: p.title, productId: p.productId, limits: p.limits });
    return { goalId: g.id };
  },
  // Product deployment by the release engineer (callTool: devops role + approval), with verification + rollback.
  "deploy.run": async (job) => {
    const { deploymentId, approvalId } = payloadOf<{ deploymentId: string; approvalId: string | null }>(job);
    return runDeployment(deploymentId, { approvalId, job });
  },
  // Follow-up change request on an existing product (targeted backlog items, not a regeneration).
  "product.change": async (job) => {
    const { productId, request, actor } = payloadOf<{ productId: string; request: string; actor: string }>(job);
    return runChangeRequest(job.companyId, productId, request, actor);
  },
  // One bounded maintenance cycle for a product (mode + budgets enforced in factory/maintenance.ts; checkpointed).
  "maintenance.cycle": async (job) => {
    const { productId, actor, cycleId } = payloadOf<{ productId: string; actor: string; cycleId?: string }>(job);
    return runMaintenanceCycle(job.companyId, productId, actor, { cycleId });
  },
  // Product experience audit (V17): static + real-browser inspection of the product's integration base; bounded, cancellable.
  "experience.audit": async (job, ctx) => {
    const { auditId } = payloadOf<{ auditId: string }>(job);
    return onFinalFailure(job, () => runExperienceAudit(auditId, ctx.signal), async (message) => {
      await prisma.experienceAudit.updateMany({ where: { id: auditId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", error: `Stopped after ${job.attempts} attempt(s): ${message}`.slice(0, 1000), finishedAt: new Date() } });
    });
  },
  // Learning: process pending learning events (also run by the worker's maintenance tick).
  "learning.process": async (job) => ({ processed: await processPending(200, [job.companyId]) }),
  // Self-test job used by health checks / acceptance tests: proves a worker is consuming the queue.
  "runtime.ping": async (job) => ({ pong: true, worker: job.workerId, at: new Date().toISOString() }),
  "product.plan": async (job) => {
    const { productId } = payloadOf<{ productId: string }>(job);
    return onFinalFailure(job, () => runPlanning(job.companyId, productId), async (message) => {
      await prisma.product.updateMany({ where: { id: productId, companyId: job.companyId }, data: { planningStatus: "FAILED", planningError: message.slice(0, 1000) } });
    });
  },
};
