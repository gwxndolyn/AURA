/**
 * Demo workspace: one isolated, per-user sample company.
 *
 * - Isolation: the demo is an ordinary workspace owned by the signed-in user
 *   (no shared account, no hardcoded credentials). Tenant isolation is the
 *   normal requireWorkspaceAccess boundary.
 * - Baseline: produced by RUNNING the real engines (mission engine, simulated
 *   deploy pipeline, cyber range, evaluation harness) at setup time — nothing
 *   is hand-written as "passed". Baseline missions are then frozen as SEEDED
 *   (read-only). Plan decisions taken during setup are attributed to the
 *   `demo-setup` actor, never to a human, and no approval gate is pre-approved.
 * - Reset: scoped to this one company id, enumerated per model, guarded by a
 *   lease (demoLockUntil) so concurrent resets are refused. The wipe +
 *   re-provision is one transaction; baseline regeneration runs after it and
 *   reports partial failure honestly. The audit log is kept.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { createCompany, provisionWorkspace } from "@/lib/company/provision";
import { audit, emitEvent } from "@/lib/events/emit";
import { advanceDays } from "@/lib/company/simulation";
import { runDeployment } from "@/lib/workflows/deploy";
import { runAttackDefense } from "@/lib/workflows/security";
import { runEvaluation } from "@/lib/intelligence/evaluation";
import { createMission, planMission, decidePlan, runUntilBlocked, cancelMission } from "@/lib/missions/engine";

export const DEMO_ACTOR = "demo-setup";
export const DEMO_NAME = "NOVA PAY (demo)";
const LOCK_MS = 3 * 60_000;

export const EXAMPLE_OBJECTIVE =
  "Investigate the failing checkout flow — a customer was charged $0.28 for a $0.29 item. Identify the cause, implement a fix, run the tests, and prepare the change for approval.";

const COMPANY_DEFAULTS = {
  name: DEMO_NAME,
  mission: "Payments and expense management for small teams. Sample workspace — all data is simulated.",
  industry: "Fintech",
  personality: "ambitious",
  autonomy: "BALANCED",
  cash: 750000,
};
const METRIC_BASELINE = {
  status: "BUILDING",
  cash: COMPANY_DEFAULTS.cash,
  revenue: 0,
  expenses: 0,
  customers: 0,
  valuation: 0,
  reputation: 50,
  uptime: 100,
  securityScore: 58,
  technicalDebt: 10,
  velocity: 20,
  simDay: 0,
  simRunning: false,
};

export interface BaselineStep {
  step: string;
  ok: boolean;
  detail: string;
}

/** Return the caller's demo workspace, creating and seeding it on first use. */
export async function ensureDemoWorkspace(userId: string): Promise<{ companyId: string; created: boolean; baseline?: BaselineStep[] }> {
  const existing = await prisma.company.findFirst({ where: { ownerId: userId, isDemo: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (existing) return { companyId: existing.id, created: false };
  const c = await createCompany({ ...COMPANY_DEFAULTS, ownerId: userId, isDemo: true });
  await audit(c.id, userId, "DEMO_CREATED", c.id, "Demo workspace provisioned");
  const baseline = await withLock(c.id, () => seedBaseline(c.id, userId));
  return { companyId: c.id, created: true, baseline };
}

/**
 * Reset a demo workspace to its baseline. Only the OWNER of a DEMO workspace
 * may do this (the route checks the role; re-checked here against the row).
 */
export async function resetDemoWorkspace(companyId: string, userId: string): Promise<{ baseline: BaselineStep[]; complete: boolean }> {
  const c = await prisma.company.findFirst({ where: { id: companyId, ownerId: userId }, select: { id: true, isDemo: true } });
  if (!c) throw new ApiError("Workspace not found", 404);
  if (!c.isDemo) throw new ApiError("Only demo workspaces can be reset", 403);

  return withLock(companyId, async () => {
    await audit(companyId, userId, "DEMO_RESET_STARTED", companyId, "Reset requested");
    // Atomic: wipe this company's simulation data and re-provision the empty workspace.
    await prisma.$transaction(async (tx) => {
      const where = { companyId };
      // Every statement is scoped to this one companyId. Dependents first.
      await tx.mission.deleteMany({ where }); // cascades plans, tasks, artifacts, approvals
      await tx.evalResult.deleteMany({ where });
      await tx.evaluation.deleteMany({ where });
      await tx.promptPromotion.deleteMany({ where });
      await tx.promptExperiment.deleteMany({ where });
      await tx.knowledgeEntry.deleteMany({ where });
      await tx.promptVersion.deleteMany({ where });
      await tx.promptTemplate.deleteMany({ where });
      await tx.routingPolicyConfig.deleteMany({ where });
      await tx.agentMessage.deleteMany({ where });
      await tx.agentRun.deleteMany({ where }); // cascades tool calls
      await tx.task.deleteMany({ where });
      await tx.sprint.deleteMany({ where });
      await tx.project.deleteMany({ where });
      await tx.deployment.deleteMany({ where });
      await tx.incident.deleteMany({ where });
      await tx.securityFinding.deleteMany({ where });
      await tx.infrastructureNode.deleteMany({ where });
      await tx.simulationEvent.deleteMany({ where });
      await tx.customer.deleteMany({ where });
      await tx.decision.deleteMany({ where });
      await tx.metric.deleteMany({ where });
      await tx.codeWorkspace.deleteMany({ where });
      await tx.timelineEvent.deleteMany({ where });
      await tx.agent.deleteMany({ where }); // cascades agent memory
      // Kept on purpose: audit log, memberships, the company row itself.
      await tx.company.update({ where: { id: companyId }, data: METRIC_BASELINE });
      await provisionWorkspace(companyId, DEMO_NAME, tx);
    });
    const baseline = await seedBaseline(companyId, userId);
    const complete = baseline.every((s) => s.ok);
    await audit(companyId, userId, "DEMO_RESET_COMPLETED", companyId, complete ? "Baseline restored" : `Partial: ${baseline.filter((s) => !s.ok).map((s) => s.step).join(", ")} failed`);
    await emitEvent({
      companyId,
      type: "COMPANY_UPDATED",
      actor: "system",
      level: complete ? "success" : "warning",
      message: complete ? "Demo workspace reset to its baseline" : "Demo reset finished, but some sample data could not be regenerated",
      meta: { analytics: "demo_reset", complete },
    });
    return { baseline, complete };
  });
}

/** Lease-based lock so two resets (or a reset during first-time seeding) cannot interleave. */
async function withLock<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const now = new Date();
  const got = await prisma.company.updateMany({
    where: { id: companyId, isDemo: true, OR: [{ demoLockUntil: null }, { demoLockUntil: { lt: now } }] },
    data: { demoLockUntil: new Date(now.getTime() + LOCK_MS) },
  });
  if (got.count !== 1) throw new ApiError("This demo workspace is already being reset; try again in a moment", 409);
  try {
    return await fn();
  } finally {
    await prisma.company.updateMany({ where: { id: companyId }, data: { demoLockUntil: null } });
  }
}

/** Mark a mission created during setup as a read-only sample. */
async function freeze(companyId: string, missionId: string) {
  await prisma.mission.updateMany({ where: { id: missionId, companyId }, data: { source: "SEEDED" } });
}

/**
 * Generate the baseline by running real engines. Each step is independent and
 * its outcome (including failure) is returned — nothing is silently skipped.
 */
async function seedBaseline(companyId: string, userId: string): Promise<BaselineStep[]> {
  const steps: BaselineStep[] = [];
  const run = async (step: string, fn: () => Promise<string>) => {
    try {
      steps.push({ step, ok: true, detail: await fn() });
    } catch (e) {
      steps.push({ step, ok: false, detail: (e as Error).message });
    }
  };

  await run("Simulated operating history", async () => {
    await advanceDays(companyId, 3);
    return "3 simulated days";
  });

  await run("Sample mission: architecture review", async () => {
    const m = await createMission({ companyId, createdById: DEMO_ACTOR, objective: "Review the notification service design for scaling risks before the holiday traffic peak." });
    try {
      await planMission(m.id, companyId);
      await decidePlan(m.id, companyId, "approve", DEMO_ACTOR, "Approved during demo setup");
      const r = await runUntilBlocked(m.id, companyId, 10);
      return `ended ${r.status.toLowerCase()}`;
    } finally {
      await freeze(companyId, m.id);
    }
  });

  await run("Sample mission: checkout fix", async () => {
    const m = await createMission({ companyId, createdById: DEMO_ACTOR, title: "Checkout undercharges by one cent (sample run)", objective: EXAMPLE_OBJECTIVE });
    try {
      await planMission(m.id, companyId);
      await decidePlan(m.id, companyId, "approve", DEMO_ACTOR, "Approved during demo setup");
      const r = await runUntilBlocked(m.id, companyId, 30);
      return `ended ${r.status.toLowerCase()}${r.waitingOn ? ` — waiting on "${r.waitingOn}"` : ""}`;
    } finally {
      await freeze(companyId, m.id);
    }
  });

  await run("Sample mission: rate limiting", async () => {
    const m = await createMission({ companyId, createdById: DEMO_ACTOR, objective: "Propose rate limiting for the public invoices API without breaking existing integrations." });
    try {
      await planMission(m.id, companyId);
      return "plan proposed; no decision taken";
    } finally {
      await freeze(companyId, m.id);
    }
  });

  await run("Sample mission: billing migration", async () => {
    const m = await createMission({ companyId, createdById: DEMO_ACTOR, objective: "Plan the migration of subscription billing to a new payment provider." });
    try {
      await planMission(m.id, companyId);
      await cancelMission(m.id, companyId, DEMO_ACTOR);
      return "cancelled during setup";
    } finally {
      await freeze(companyId, m.id);
    }
  });

  await run("Release to staging (simulated pipeline)", async () => {
    const d = await runDeployment(companyId, "staging");
    return d.success ? "staging release succeeded (simulated pipeline)" : `staging release failed at ${d.failedStage} (simulated pipeline)`;
  });

  await run("Cyber range exercise (isolated toy target)", async () => {
    await runAttackDefense(companyId, { attackType: "Reflected XSS" });
    return "Reflected XSS against the in-process range";
  });

  await run("Agent evaluation", async () => {
    const e = await runEvaluation({ companyId, agentKey: "product-manager", datasetId: "product-manager", label: "baseline", createdBy: DEMO_ACTOR, seedSalt: "demo" });
    return `evaluation ${e.status.toLowerCase()}`;
  });

  await audit(companyId, userId, "DEMO_BASELINE", companyId, steps.map((s) => `${s.ok ? "ok" : "FAILED"}: ${s.step}`).join("; "));
  return steps;
}
