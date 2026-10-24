/**
 * Operational actions: catalog, recommendations, policy, execution.
 *
 * Every action maps to an EXISTING service (mission engine, deploy pipeline,
 * evaluation harness). The policy is enforced here, in application code,
 * before the service is called — never by a prompt. Every attempt (allowed or
 * blocked) is persisted as an OpsAction with the policy clause that decided it
 * and the service's actual result.
 *
 * Policy levels (OpsMonitor.policyLevel):
 *   OBSERVE     — detect + explain only; no state-changing action, even by a user, from the ops center.
 *   RECOMMEND   — users may run allowed actions; nothing runs automatically.
 *   BOUNDED     — additionally, actions listed in allowedAutoActions that are low-risk
 *                 and reversible/idempotent may run automatically, rate-limited.
 *   CONTINUOUS  — like BOUNDED, but evaluations also run on the monitor schedule.
 * Regardless of level: production/consequential actions require an approval
 * that only a human can grant; agents/AI summaries can never trigger actions.
 */
import { prisma } from "@/lib/db";
import { audit, emitEvent } from "@/lib/events/emit";
import { parseJSON } from "@/lib/utils";
import { ROLE_RANK } from "@/lib/auth/authz";
import { retryTask, pauseMission, resumeMission, cancelMission, advanceMission, RETRYABLE_CATEGORIES } from "@/lib/missions/engine";
import { rollbackDeployment } from "@/lib/workflows/deploy";
import { runEvaluation } from "@/lib/intelligence/evaluation";
import { getDataset } from "@/lib/intelligence/datasets";

export const POLICY_LEVELS = ["OBSERVE", "RECOMMEND", "BOUNDED", "CONTINUOUS"] as const;
export type PolicyLevel = (typeof POLICY_LEVELS)[number];

export const ACTION_TYPES = ["retry_task", "retry_task_default_timeouts", "recover_lease", "pause_mission", "resume_mission", "cancel_mission", "rerun_evaluation", "rollback_deployment"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface ActionSpec {
  type: ActionType;
  label: string;
  risk: "low" | "medium" | "high";
  reversible: boolean;
  idempotent: boolean;
  /** Minimum workspace role a user needs to run it. */
  minRole: "MEMBER" | "ADMIN" | "OWNER";
  /** May ever run automatically (still requires BOUNDED/CONTINUOUS + explicit allow-list). */
  autoEligible: boolean;
  costNote: string;
}

export const ACTIONS: Record<ActionType, ActionSpec> = {
  retry_task: { type: "retry_task", label: "Retry the task", risk: "low", reversible: false, idempotent: true, minRole: "MEMBER", autoEligible: true, costNote: "Re-runs one task: model + tool calls within the task's own budget." },
  retry_task_default_timeouts: { type: "retry_task_default_timeouts", label: "Retry with default tool timeouts", risk: "low", reversible: false, idempotent: true, minRole: "MEMBER", autoEligible: false, costNote: "Re-runs one task after removing this mission's tighter tool-timeout overrides." },
  recover_lease: { type: "recover_lease", label: "Recover the lost task", risk: "low", reversible: false, idempotent: true, minRole: "MEMBER", autoEligible: true, costNote: "One engine step; re-runs the interrupted attempt." },
  pause_mission: { type: "pause_mission", label: "Pause the mission", risk: "low", reversible: true, idempotent: true, minRole: "MEMBER", autoEligible: true, costNote: "No model cost; stops further spend." },
  resume_mission: { type: "resume_mission", label: "Resume the mission", risk: "medium", reversible: true, idempotent: true, minRole: "MEMBER", autoEligible: false, costNote: "Execution continues and spends budget." },
  cancel_mission: { type: "cancel_mission", label: "Cancel the mission", risk: "high", reversible: false, idempotent: false, minRole: "ADMIN", autoEligible: false, costNote: "No cost; remaining work is abandoned." },
  rerun_evaluation: { type: "rerun_evaluation", label: "Re-run the evaluation", risk: "low", reversible: true, idempotent: true, minRole: "MEMBER", autoEligible: true, costNote: "One evaluation run over the dataset (model calls per case)." },
  rollback_deployment: { type: "rollback_deployment", label: "Roll back the deployment", risk: "medium", reversible: false, idempotent: false, minRole: "ADMIN", autoEligible: false, costNote: "Re-runs the simulated pipeline for the previous version." },
};

export interface ActionTarget {
  type: "mission" | "task" | "deployment" | "evaluation";
  id: string;
  /** For tasks: the mission + key. For evaluations: the agent + dataset. */
  missionId?: string;
  taskKey?: string;
  agentKey?: string;
  datasetId?: string;
}

export interface Recommendation {
  action: ActionType;
  label: string;
  reason: string;
  expectedOutcome: string;
  risks: string;
  cost: string;
  requiresApproval: boolean;
  reversible: boolean;
  target: ActionTarget;
  /** Null when runnable now; otherwise why it cannot run (shown instead of a dead button). */
  unavailable: string | null;
  /** Policy evaluation for a user at the current level (computed at read time). */
  policy?: PolicyDecision;
}

export interface PolicyDecision {
  decision: "allowed" | "blocked" | "requires_approval";
  rule: string;
  detail: string;
}

/**
 * The policy. Pure. `trigger` distinguishes user-initiated from automatic.
 * Clauses are checked in order; the first that applies decides and is recorded.
 */
export function decidePolicy(input: {
  level: PolicyLevel;
  action: ActionType;
  trigger: "user" | "automatic";
  role?: string;
  allowedAuto: string[];
  autoActionsLastHour: number;
  maxAutoPerHour: number;
  target: ActionTarget & { env?: string };
}): PolicyDecision {
  const spec = ACTIONS[input.action];
  if (!spec) return { decision: "blocked", rule: "unknown_action", detail: `Unknown action ${input.action}` };
  if (input.action === "rollback_deployment" && input.target.env === "production")
    return { decision: "requires_approval", rule: "production_requires_approval", detail: "Production changes require a human approval through the deployment gate; they cannot be run from the operations center." };
  if (input.level === "OBSERVE") return { decision: "blocked", rule: "level_observe", detail: "Workspace operations policy is Observe: findings are explained, no state-changing action runs." };
  if (input.trigger === "user") {
    if (!input.role || ROLE_RANK[input.role] < ROLE_RANK[spec.minRole]) return { decision: "blocked", rule: "role_insufficient", detail: `Requires the ${spec.minRole} role.` };
    return { decision: "allowed", rule: `user_initiated@${input.level.toLowerCase()}`, detail: `A ${input.role} may run "${spec.label}" under the ${input.level} policy.` };
  }
  // automatic
  if (input.level === "RECOMMEND") return { decision: "blocked", rule: "level_recommend_no_auto", detail: "Recommend policy: actions run only when a user starts them." };
  if (!spec.autoEligible || spec.risk !== "low") return { decision: "blocked", rule: "not_auto_eligible", detail: `"${spec.label}" is ${spec.risk}-risk and never runs automatically.` };
  if (!input.allowedAuto.includes(input.action)) return { decision: "blocked", rule: "not_in_allowlist", detail: `"${spec.label}" is not in this workspace's automatic-action allow-list.` };
  if (input.autoActionsLastHour >= input.maxAutoPerHour) return { decision: "blocked", rule: "rate_limited", detail: `Automatic action limit reached (${input.maxAutoPerHour}/hour).` };
  return { decision: "allowed", rule: `auto_allowlisted@${input.level.toLowerCase()}`, detail: `"${spec.label}" is allow-listed for automatic execution under ${input.level}.` };
}

// ---------------------------------------------------------------------------
// Recommendations (grounded in the finding + current state)
// ---------------------------------------------------------------------------

type FindingRow = NonNullable<Awaited<ReturnType<typeof prisma.opsFinding.findFirst>>>;

function rec(action: ActionType, target: ActionTarget, reason: string, expectedOutcome: string, risks: string, unavailable: string | null, requiresApproval = false): Recommendation {
  const s = ACTIONS[action];
  return { action, label: s.label, reason, expectedOutcome, risks, cost: s.costNote, requiresApproval, reversible: s.reversible, target, unavailable };
}

export async function recommendationsFor(f: FindingRow): Promise<Recommendation[]> {
  const out: Recommendation[] = [];
  const facts = parseJSON<Record<string, unknown>>(f.facts, {});
  const mission = f.missionId ? await prisma.mission.findFirst({ where: { id: f.missionId, companyId: f.companyId } }) : null;

  if (f.ruleId === "task.overrun" && mission) {
    const task = await prisma.missionTask.findFirst({ where: { id: f.resourceId, companyId: f.companyId } });
    if (task) {
      out.push(rec("recover_lease", { type: "task", id: task.id, missionId: mission.id, taskKey: task.key }, facts.leaseExpired ? "The worker holding this task is gone (lease expired)." : "The task is running far longer than expected.", "The engine reclaims the task and re-runs the interrupted attempt; the dead attempt is recorded as abandoned.", "Re-runs model/tool calls for that task.", facts.leaseExpired ? null : "The lease has not expired yet — a live worker may still finish; wait or pause the mission."));
      out.push(rec("pause_mission", { type: "mission", id: mission.id }, "Stop further work while you investigate.", "No new task is claimed until resumed.", "Delays the mission.", mission.status === "RUNNING" || mission.status === "READY" ? null : `Mission is ${mission.status.toLowerCase()}.`));
    }
  }

  if (["mission.repeated_verification_failure", "engineering.tests_failing", "mission.failed"].includes(f.ruleId) && mission) {
    const key = f.ruleId === "mission.repeated_verification_failure" ? f.resourceId.split(":")[1] : null;
    const failedTasks = await prisma.missionTask.findMany({ where: { missionId: mission.id, planVersion: mission.planVersion, status: "FAILED", ...(key ? { key } : {}) } });
    const overrides = parseJSON<Record<string, number>>(mission.toolTimeouts, {});
    for (const t of failedTasks) {
      const transient = RETRYABLE_CATEGORIES.includes(t.errorCategory ?? "");
      // A timeout under a mission-specific tighter limit: retrying unchanged will time out again.
      if (t.errorCategory === "tool_timeout" && Object.keys(overrides).length) {
        out.push(rec("retry_task_default_timeouts", { type: "task", id: t.id, missionId: mission.id, taskKey: t.key }, `"${t.key}" timed out under this mission's override (${Object.entries(overrides).map(([k, v]) => `${k} ${v}ms`).join(", ")}).`, "Overrides are removed and the task re-runs with each tool's standard timeout.", "Spends task budget; if the tool is genuinely slow it may still time out.", null));
        out.push(rec("retry_task", { type: "task", id: t.id, missionId: mission.id, taskKey: t.key }, `Retry "${t.key}" with the same settings.`, "Likely the same timeout.", "Spends task budget for a probable repeat.", null));
        continue;
      }
      out.push(rec("retry_task", { type: "task", id: t.id, missionId: mission.id, taskKey: t.key }, transient ? `"${t.key}" failed with ${t.errorCategory}, which is usually transient.` : `"${t.key}" failed with ${t.errorCategory ?? "an unknown error"}.`, "The task and its skipped dependents return to PENDING and run again.", "Spends task budget; a deterministic failure will fail again.", transient ? null : `${t.errorCategory ?? "This"} failure is not transient — a retry would repeat it. Inspect the evidence or start an investigation mission instead.`));
    }
  }

  if (["mission.blocked", "mission.repairs_exhausted"].includes(f.ruleId) && mission) {
    out.push(rec("cancel_mission", { type: "mission", id: mission.id }, f.ruleId === "mission.blocked" ? "If the work is no longer wanted, stop waiting on it." : "Automatic repair has stopped; cancel if a different approach is needed.", "The mission stops; queued tasks are skipped.", "Not reversible.", ["COMPLETED", "FAILED", "CANCELLED"].includes(mission.status) ? `Mission is already ${mission.status.toLowerCase()}.` : null));
  }

  if (f.ruleId === "mission.budget" && mission) {
    const live = mission.status === "RUNNING" || mission.status === "READY";
    out.push(rec("pause_mission", { type: "mission", id: mission.id }, `Mission has used ${Math.round(Number(facts.ratio ?? 0) * 100)}% of its estimated budget.`, "No further tasks are claimed; spend stops until you resume.", "Delays the mission.", live ? null : `Mission is ${mission.status.toLowerCase()}; nothing to pause.`));
    if (mission.status === "PAUSED" && mission.operatorHold) out.push(rec("resume_mission", { type: "mission", id: mission.id }, "Resume once you accept the remaining spend.", "Execution continues.", "Spends the remaining budget.", null));
  }

  if (f.ruleId === "engineering.deployment_failed") {
    const env = String(facts.env ?? f.resourceId);
    const latest = await prisma.deployment.findFirst({ where: { companyId: f.companyId, env, status: "FAILED" }, orderBy: { createdAt: "desc" } });
    const prior = latest ? await prisma.deployment.findFirst({ where: { companyId: f.companyId, env, status: "SUCCESS", createdAt: { lt: latest.createdAt } } }) : null;
    if (latest) out.push(rec("rollback_deployment", { type: "deployment", id: latest.id }, `${env} ${latest.version} failed its pipeline.`, prior ? `${env} returns to ${prior.version} via a re-run of the simulated pipeline.` : "", "Rollback runs the simulated pipeline; it can itself fail.", !prior ? `No earlier successful ${env} deployment to roll back to.` : env === "production" ? "Production rollbacks need human approval through the deployment gate." : null, env === "production"));
  }

  if (f.ruleId === "evaluation.regression") {
    const [agentKey, datasetId, mode] = f.resourceId.split("|");
    const ds = getDataset(datasetId);
    out.push(rec("rerun_evaluation", { type: "evaluation", id: f.resourceId, agentKey, datasetId }, "Confirm whether the drop reproduces before acting on it.", "A new evaluation run over the same dataset; the regression rule re-checks against it.", `Uses model calls per case${mode === "simulation" ? " (simulator: fixtures measure the harness, not a model)" : ""}.`, ds ? null : `Dataset ${datasetId} is no longer registered.`));
  }

  if (f.ruleId === "agent.invalid_output" || f.ruleId === "agent.timeouts") {
    const ds = getDataset(f.resourceId);
    out.push(rec("rerun_evaluation", { type: "evaluation", id: `${f.resourceId}|${f.resourceId}|simulation`, agentKey: f.resourceId, datasetId: f.resourceId }, "Measure the agent on its fixed dataset to separate a real regression from mission noise.", "A new evaluation run you can compare against earlier ones.", "Model calls per case.", ds ? null : `No evaluation dataset is registered for ${f.resourceId}.`));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export class ActionError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "ActionError";
  }
}

async function policyContext(companyId: string) {
  const mon = await prisma.opsMonitor.findUnique({ where: { companyId } });
  const hourAgo = new Date(Date.now() - 3600_000);
  const autoActionsLastHour = await prisma.opsAction.count({ where: { companyId, trigger: "automatic", decision: "allowed", createdAt: { gte: hourAgo } } });
  return {
    level: (mon?.policyLevel ?? "RECOMMEND") as PolicyLevel,
    allowedAuto: parseJSON<string[]>(mon?.allowedAutoActions, []),
    maxAutoPerHour: mon?.maxAutoActionsPerHour ?? 5,
    autoActionsLastHour,
  };
}

/** Resolve the deployment env for policy (production gate) — scoped to the workspace. */
async function targetEnv(companyId: string, t: ActionTarget) {
  if (t.type !== "deployment") return undefined;
  return (await prisma.deployment.findFirst({ where: { id: t.id, companyId }, select: { env: true } }))?.env;
}

async function runService(companyId: string, action: ActionType, t: ActionTarget, actor: string): Promise<Record<string, unknown>> {
  switch (action) {
    case "retry_task":
      if (!t.missionId || !t.taskKey) throw new ActionError("retry_task needs a mission and task", 422);
      return retryTask(t.missionId, companyId, t.taskKey, actor);
    case "retry_task_default_timeouts":
      if (!t.missionId || !t.taskKey) throw new ActionError("retry needs a mission and task", 422);
      return retryTask(t.missionId, companyId, t.taskKey, actor, { clearToolTimeouts: true });
    case "recover_lease": {
      if (!t.missionId) throw new ActionError("recover_lease needs a mission", 422);
      const r = await advanceMission(t.missionId, companyId); // the engine reclaims expired leases on advance
      return { ...r };
    }
    case "pause_mission":
      return pauseMission(t.id, companyId, actor, `Paused from operations by ${actor}`);
    case "resume_mission":
      return resumeMission(t.id, companyId, actor);
    case "cancel_mission":
      await cancelMission(t.id, companyId, actor);
      return { status: "CANCELLED" };
    case "rerun_evaluation": {
      if (!t.agentKey || !t.datasetId) throw new ActionError("rerun_evaluation needs agent + dataset", 422);
      const e = await runEvaluation({ companyId, agentKey: t.agentKey, datasetId: t.datasetId, label: "regression", createdBy: actor });
      return { evaluationId: e.evaluationId, status: e.status, passRate: e.run.passRate, total: e.run.total, mode: e.run.mode };
    }
    case "rollback_deployment":
      return rollbackDeployment(companyId, t.id, actor);
  }
}

/**
 * Execute an action through policy. Returns the persisted OpsAction. Blocked
 * attempts are recorded too (that is part of the audit trail).
 */
export async function executeAction(input: { companyId: string; action: ActionType; target: ActionTarget; findingId?: string; actor: string; role?: string; trigger: "user" | "automatic" }) {
  const spec = ACTIONS[input.action];
  if (!spec) throw new ActionError(`Unknown action ${input.action}`, 422);
  if (input.findingId) {
    const f = await prisma.opsFinding.findFirst({ where: { id: input.findingId, companyId: input.companyId }, select: { id: true } });
    if (!f) throw new ActionError("Finding not found", 404);
  }
  const ctx = await policyContext(input.companyId);
  const env = await targetEnv(input.companyId, input.target);
  const decision = decidePolicy({ ...ctx, action: input.action, trigger: input.trigger, role: input.role, target: { ...input.target, env } });

  const row = await prisma.opsAction.create({
    data: {
      companyId: input.companyId,
      findingId: input.findingId ?? null,
      actionType: input.action,
      target: JSON.stringify(input.target),
      initiatedBy: input.actor,
      trigger: input.trigger,
      policyLevel: ctx.level,
      policyRule: decision.rule,
      decision: decision.decision,
      status: decision.decision === "allowed" ? "running" : "blocked",
      result: JSON.stringify({ policy: decision.detail }),
    },
  });
  await audit(input.companyId, input.actor, decision.decision === "allowed" ? "OPS_ACTION_ALLOWED" : "OPS_ACTION_BLOCKED", `${input.action}:${input.target.type}:${input.target.id}`, `${decision.rule}: ${decision.detail}`);
  if (decision.decision !== "allowed") {
    await emitEvent({ companyId: input.companyId, type: "OPS_ACTION", actor: "system", level: "warning", message: `Blocked ${spec.label}: ${decision.detail}`, meta: { actionId: row.id, rule: decision.rule }, ops: { severity: "info", source: "ops", resourceType: input.target.type, resourceId: input.target.id } });
    return { action: row, decision };
  }

  try {
    const result = await runService(input.companyId, input.action, input.target, input.actor);
    const done = await prisma.opsAction.update({ where: { id: row.id }, data: { status: "succeeded", result: JSON.stringify({ policy: decision.detail, service: result }), completedAt: new Date() } });
    await emitEvent({ companyId: input.companyId, type: "OPS_ACTION", actor: "system", level: "success", message: `${spec.label}: done`, meta: { actionId: row.id }, ops: { severity: "info", source: "ops", resourceType: input.target.type, resourceId: input.target.id } });
    if (input.findingId) await appendFindingHistory(input.findingId, input.actor, `action ${input.action} succeeded`, JSON.stringify(result).slice(0, 300));
    return { action: done, decision };
  } catch (e) {
    const msg = (e as Error).message;
    const done = await prisma.opsAction.update({ where: { id: row.id }, data: { status: "failed", error: msg.slice(0, 1000), completedAt: new Date() } });
    await emitEvent({ companyId: input.companyId, type: "OPS_ACTION", actor: "system", level: "danger", message: `${spec.label} failed: ${msg}`, meta: { actionId: row.id }, ops: { severity: "medium", source: "ops", resourceType: input.target.type, resourceId: input.target.id } });
    if (input.findingId) await appendFindingHistory(input.findingId, input.actor, `action ${input.action} failed`, msg.slice(0, 300));
    return { action: done, decision };
  }
}

export async function appendFindingHistory(findingId: string, actor: string, change: string, detail?: string) {
  const f = await prisma.opsFinding.findUnique({ where: { id: findingId }, select: { history: true } });
  if (!f) return;
  const h = parseJSON<{ at: string; actor: string; change: string; detail?: string }[]>(f.history, []);
  await prisma.opsFinding.update({ where: { id: findingId }, data: { history: JSON.stringify([...h, { at: new Date().toISOString(), actor, change, detail }].slice(-50)) } });
}
