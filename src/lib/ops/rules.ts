/**
 * Deterministic, versioned operational health rules.
 *
 * Each rule is a pure function over an `OpsSnapshot` (persisted state loaded
 * by snapshot.ts). A rule returns, per resource it is responsible for, one of:
 *   - `fire`    — the trigger condition holds, with the evidence that proves it
 *   - `clear`   — the resolution condition holds (an open finding may resolve)
 *   - `unknown` — required evidence is missing; NOTHING is raised and the
 *                 reason is recorded on the evaluation run
 * Rules never call a model. Thresholds are configurable per workspace.
 *
 * Certainty vocabulary (shown in the UI):
 *   confirmed  — a recorded failure (e.g. a test run failed, a lease expired)
 *   warning    — a threshold was crossed but nothing has failed yet
 *   prediction — extrapolated from a trend (e.g. budget burn)
 *   suspicion  — a weak or small-sample signal; never escalated to critical
 */

export type Severity = "low" | "medium" | "high" | "critical";
export type Certainty = "confirmed" | "warning" | "prediction" | "suspicion";
export type Category = "mission" | "agent" | "engineering" | "evaluation";

export interface EvidenceRef {
  kind: "mission" | "task" | "run" | "tool_call" | "finding" | "approval" | "deployment" | "evaluation" | "event" | "config";
  id: string;
  label: string;
  detail?: string;
}

export interface Resource {
  type: "mission" | "task" | "agent" | "tool" | "deployment" | "evaluation" | "integration";
  id: string;
  label: string;
  missionId?: string;
}

export type RuleOutcome =
  | { kind: "fire"; resource: Resource; severity: Severity; severityReason: string; certainty: Certainty; title: string; explanation: string; evidence: EvidenceRef[]; facts: Record<string, unknown>; nextAction: string; requiresHuman: boolean }
  | { kind: "clear"; resource: Resource; reason: string }
  | { kind: "unknown"; resource: Resource; reason: string };

export interface Thresholds {
  blockedMinutes: number; // mission waiting on a human longer than this
  taskOverrunFactor: number; // running task older than factor × capability max duration
  repeatedVerificationFailures: number;
  budgetWarnRatio: number; // cost / budget
  invalidOutputMinSample: number;
  invalidOutputRate: number;
  timeoutMinSample: number;
  timeoutRate: number;
  toolFailureMinSample: number;
  toolFailureRate: number;
  evalMinCases: number; // per evaluation, to count as comparable evidence
  evalRegressionDrop: number; // absolute pass-rate drop vs baseline
  costPerSuccessIncrease: number; // relative increase vs baseline window
  costMinSuccesses: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  blockedMinutes: 60,
  taskOverrunFactor: 2,
  repeatedVerificationFailures: 2,
  budgetWarnRatio: 0.8,
  invalidOutputMinSample: 5,
  invalidOutputRate: 0.4,
  timeoutMinSample: 5,
  timeoutRate: 0.3,
  toolFailureMinSample: 5,
  toolFailureRate: 0.5,
  evalMinCases: 3,
  evalRegressionDrop: 0.1,
  costPerSuccessIncrease: 0.5,
  costMinSuccesses: 5,
};

// --- snapshot shape (plain data; built by snapshot.ts) ----------------------

export interface SnapMission {
  id: string;
  title: string;
  status: string;
  source: string;
  costUsd: number;
  budgetUsd: number;
  repairRounds: number;
  maxRepairs: number;
  statusReason: string;
  updatedAt: Date; // last status-change evidence (latest run/approval/mission event)
}
export interface SnapTask {
  id: string;
  missionId: string;
  key: string;
  title: string;
  kind: string;
  agentKey: string;
  status: string;
  errorCategory: string | null;
  startedAt: Date | null;
  leaseExpiresAt: Date | null;
  maxDurationMs: number | null; // from the agent capability; null = unknown
}
export interface SnapRun {
  id: string;
  missionId: string;
  taskKey: string;
  taskKind: string;
  agentKey: string;
  status: string;
  outcome: string;
  errorCategory: string | null;
  outputValid: boolean;
  costUsd: number;
  startedAt: Date;
}
export interface SnapApproval {
  id: string;
  missionId: string;
  status: string;
  createdAt: Date;
  action: string;
}
export interface SnapToolCall {
  id: string;
  tool: string;
  status: string;
  createdAt: Date;
}
export interface SnapDeployment {
  id: string;
  env: string;
  version: string;
  status: string;
  failedStage: string | null;
  createdAt: Date;
}
export interface SnapEvaluation {
  id: string;
  agentKey: string;
  datasetId: string;
  mode: string;
  label: string;
  status: string;
  total: number;
  passRate: number;
  promptKey: string;
  promptVersion: number;
  model: string;
  startedAt: Date;
}
export interface SnapIntegration {
  id: "sandbox" | "model";
  label: string;
  available: boolean | null; // null = not probed
  detail: string;
}

export interface OpsSnapshot {
  now: Date;
  missions: SnapMission[];
  tasks: SnapTask[];
  runs: SnapRun[];
  approvals: SnapApproval[];
  toolCalls: SnapToolCall[]; // recent window
  deployments: SnapDeployment[];
  evaluations: SnapEvaluation[];
  integrations: SnapIntegration[];
  /** Reviewer/QA findings still open, by mission (from MissionFinding). */
  blockingReviewFindings: { id: string; missionId: string; code: string; title: string; severity: string; status: string }[];
}

export interface Rule {
  id: string;
  version: number;
  category: Category;
  title: string;
  /** Human-readable rule definition, shown in the UI and docs. */
  definition: { evidence: string; trigger: string; severity: string; dedupe: string; resolution: string; falsePositives: string; humanAction: string };
  evaluate: (s: OpsSnapshot, t: Thresholds) => RuleOutcome[];
}

const minutes = (a: Date, b: Date) => (a.getTime() - b.getTime()) / 60_000;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const missionRes = (m: SnapMission): Resource => ({ type: "mission", id: m.id, label: m.title, missionId: m.id });
const activeMissions = (s: OpsSnapshot) => s.missions.filter((m) => m.source !== "SEEDED");

// ---------------------------------------------------------------------------
// Mission health
// ---------------------------------------------------------------------------

const missionBlocked: Rule = {
  id: "mission.blocked",
  version: 1,
  category: "mission",
  title: "Mission blocked on a human decision",
  definition: {
    evidence: "Mission status (AWAITING_APPROVAL or PAUSED) and the pending plan/approval row with its creation time.",
    trigger: "Waiting longer than `blockedMinutes`.",
    severity: "medium; high when waiting more than 4× the threshold.",
    dedupe: "One finding per mission.",
    resolution: "Mission is no longer AWAITING_APPROVAL/PAUSED, or the approval is decided.",
    falsePositives: "A human may be deliberately holding the decision — acknowledging the finding silences it.",
    humanAction: "Yes — only a person may decide plans and approval gates.",
  },
  evaluate(s, t) {
    const out: RuleOutcome[] = [];
    for (const m of activeMissions(s)) {
      const waiting = m.status === "AWAITING_APPROVAL" || m.status === "PAUSED";
      if (!waiting) {
        out.push({ kind: "clear", resource: missionRes(m), reason: `mission is ${m.status.toLowerCase()}` });
        continue;
      }
      const approval = m.status === "PAUSED" ? s.approvals.find((a) => a.missionId === m.id && a.status === "PENDING") : undefined;
      if (m.status === "PAUSED" && !approval) {
        out.push({ kind: "unknown", resource: missionRes(m), reason: "paused but no pending approval row found" });
        continue;
      }
      const since = approval?.createdAt ?? m.updatedAt;
      const waited = minutes(s.now, since);
      if (waited < t.blockedMinutes) {
        out.push({ kind: "clear", resource: missionRes(m), reason: `waiting ${Math.round(waited)} min (< ${t.blockedMinutes})` });
        continue;
      }
      const what = approval ? `approval gate "${approval.action}"` : "plan approval";
      out.push({
        kind: "fire",
        resource: missionRes(m),
        severity: waited > 4 * t.blockedMinutes ? "high" : "medium",
        severityReason: `waiting ${Math.round(waited)} min; threshold ${t.blockedMinutes} min${waited > 4 * t.blockedMinutes ? " (>4×)" : ""}`,
        certainty: "confirmed",
        title: `Mission waiting on ${approval ? "an approval" : "plan approval"} for ${Math.round(waited)} min`,
        explanation: `"${m.title}" cannot continue until a person decides the ${what}.`,
        evidence: [{ kind: "mission", id: m.id, label: m.title, detail: `status ${m.status}` }, ...(approval ? [{ kind: "approval" as const, id: approval.id, label: approval.action, detail: `requested ${approval.createdAt.toISOString()}` }] : []), { kind: "config", id: "blockedMinutes", label: "threshold", detail: `${t.blockedMinutes} min` }],
        facts: { waitedMinutes: Math.round(waited), thresholdMinutes: t.blockedMinutes, status: m.status },
        nextAction: approval ? "Review the evidence and decide the approval gate." : "Review and approve or reject the plan.",
        requiresHuman: true,
      });
    }
    return out;
  },
};

const taskOverrun: Rule = {
  id: "task.overrun",
  version: 1,
  category: "mission",
  title: "Task running past its expected duration",
  definition: {
    evidence: "Task RUNNING with startedAt, and the owning agent's declared max duration (capability registry).",
    trigger: "Running longer than `taskOverrunFactor` × max duration. An expired lease is reported as confirmed (worker lost).",
    severity: "medium; high if the lease has expired.",
    dedupe: "One finding per task.",
    resolution: "Task is no longer RUNNING.",
    falsePositives: "Slow sandbox start-up; the factor gives headroom. No max duration → unknown, not raised.",
    humanAction: "No — the engine recovers expired leases on the next advance; a retry is recommended.",
  },
  evaluate(s, t) {
    const out: RuleOutcome[] = [];
    for (const task of s.tasks) {
      const res: Resource = { type: "task", id: task.id, label: `${task.title} (${task.key})`, missionId: task.missionId };
      if (task.status !== "RUNNING") {
        out.push({ kind: "clear", resource: res, reason: `task is ${task.status.toLowerCase()}` });
        continue;
      }
      if (!task.startedAt || task.maxDurationMs === null) {
        out.push({ kind: "unknown", resource: res, reason: !task.startedAt ? "no start time recorded" : `no declared max duration for ${task.agentKey}` });
        continue;
      }
      const ranMs = s.now.getTime() - task.startedAt.getTime();
      const leaseExpired = !!task.leaseExpiresAt && task.leaseExpiresAt < s.now;
      if (ranMs < t.taskOverrunFactor * task.maxDurationMs && !leaseExpired) {
        out.push({ kind: "clear", resource: res, reason: "within expected duration" });
        continue;
      }
      out.push({
        kind: "fire",
        resource: res,
        severity: leaseExpired ? "high" : "medium",
        severityReason: leaseExpired ? "lease expired — the worker is gone" : `${Math.round(ranMs / 1000)}s vs expected ≤ ${Math.round(task.maxDurationMs / 1000)}s`,
        certainty: leaseExpired ? "confirmed" : "warning",
        title: leaseExpired ? `Task "${task.key}" lost its worker` : `Task "${task.key}" is taking ${Math.round(ranMs / 1000)}s`,
        explanation: leaseExpired ? "The task's lease expired while RUNNING, so the worker that held it crashed or was stopped." : `${task.agentKey} has been running longer than ${t.taskOverrunFactor}× its declared maximum.`,
        evidence: [{ kind: "task", id: task.id, label: task.key, detail: `started ${task.startedAt.toISOString()}` }, { kind: "config", id: "maxDuration", label: `${task.agentKey} max duration`, detail: `${task.maxDurationMs} ms` }],
        facts: { ranMs, maxDurationMs: task.maxDurationMs, leaseExpired },
        nextAction: "Advance the mission so the engine reclaims the task, or retry it.",
        requiresHuman: false,
      });
    }
    return out;
  },
};

const repeatedVerificationFailure: Rule = {
  id: "mission.repeated_verification_failure",
  version: 1,
  category: "mission",
  title: "Same verification step failing repeatedly",
  definition: {
    evidence: "Task runs of TEST/REVIEW kind with outcome tests_failed / changes_requested or status FAILED.",
    trigger: "≥ `repeatedVerificationFailures` failed runs of the same task in one mission.",
    severity: "medium; high when the mission has also exhausted its repair rounds.",
    dedupe: "One finding per (mission, task).",
    resolution: "The latest run of that task passed.",
    falsePositives: "A repair in progress is expected to fail once — hence the ≥2 threshold.",
    humanAction: "Recommended — inspect the failing evidence.",
  },
  evaluate(s, t) {
    const out: RuleOutcome[] = [];
    const groups = new Map<string, SnapRun[]>();
    for (const r of s.runs) if (["TEST", "REVIEW"].includes(r.taskKind)) groups.set(`${r.missionId}:${r.taskKey}`, [...(groups.get(`${r.missionId}:${r.taskKey}`) ?? []), r]);
    for (const [key, runs] of groups) {
      const [missionId, taskKey] = key.split(":");
      const m = s.missions.find((x) => x.id === missionId);
      if (!m || m.source === "SEEDED") continue;
      const res: Resource = { type: "task", id: key, label: `${taskKey} in "${m.title}"`, missionId };
      const sorted = [...runs].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
      const failed = sorted.filter((r) => r.status === "FAILED" || ["tests_failed", "changes_requested"].includes(r.outcome));
      const last = sorted[sorted.length - 1];
      const lastPassed = last.status === "SUCCEEDED" && ["passed", "approved"].includes(last.outcome);
      if (lastPassed || failed.length < t.repeatedVerificationFailures) {
        out.push({ kind: "clear", resource: res, reason: lastPassed ? "latest run passed" : `${failed.length} failure(s)` });
        continue;
      }
      const exhausted = m.repairRounds >= m.maxRepairs;
      out.push({
        kind: "fire",
        resource: res,
        severity: exhausted ? "high" : "medium",
        severityReason: `${failed.length} failed runs${exhausted ? "; repair rounds exhausted" : ""}`,
        certainty: "confirmed",
        title: `"${taskKey}" failed ${failed.length} times`,
        explanation: `The ${last.taskKind === "TEST" ? "test suite" : "review"} for "${m.title}" keeps failing; repairs so far have not fixed it.`,
        evidence: failed.slice(-4).map((r) => ({ kind: "run" as const, id: r.id, label: `${taskKey} run`, detail: `${r.outcome || r.status}${r.errorCategory ? ` (${r.errorCategory})` : ""}` })),
        facts: { failures: failed.length, repairRounds: m.repairRounds, maxRepairs: m.maxRepairs },
        nextAction: "Open the failing run's evidence; if repairs are exhausted, start a bounded investigation mission.",
        requiresHuman: exhausted,
      });
    }
    return out;
  },
};

const budgetThreshold: Rule = {
  id: "mission.budget",
  version: 1,
  category: "mission",
  title: "Mission approaching or over budget",
  definition: {
    evidence: "Mission costUsd and budgetUsd (estimated from recorded agent runs).",
    trigger: "cost ≥ `budgetWarnRatio` × budget on a non-terminal mission (prediction), or a mission FAILED with a budget reason (confirmed).",
    severity: "medium at the warning ratio; high when exhausted.",
    dedupe: "One finding per mission.",
    resolution: "Ratio back below the threshold (budget raised) or the mission finished for another reason.",
    falsePositives: "Costs are estimates in simulation mode; the finding says so.",
    humanAction: "Yes when exhausted (raise budget or stop); otherwise optional.",
  },
  evaluate(s, t) {
    const out: RuleOutcome[] = [];
    for (const m of activeMissions(s)) {
      const res = missionRes(m);
      if (m.budgetUsd <= 0) {
        out.push({ kind: "unknown", resource: res, reason: "no budget configured" });
        continue;
      }
      const ratio = m.costUsd / m.budgetUsd;
      const exhausted = m.status === "FAILED" && /budget/i.test(m.statusReason);
      const live = !["COMPLETED", "FAILED", "CANCELLED"].includes(m.status);
      if (!exhausted && !(live && ratio >= t.budgetWarnRatio)) {
        out.push({ kind: "clear", resource: res, reason: `${pct(ratio)} of budget` });
        continue;
      }
      out.push({
        kind: "fire",
        resource: res,
        severity: exhausted ? "high" : "medium",
        severityReason: `${pct(ratio)} of $${m.budgetUsd} used`,
        certainty: exhausted ? "confirmed" : "prediction",
        title: exhausted ? `Mission stopped: budget exhausted` : `Mission at ${pct(ratio)} of its budget`,
        explanation: exhausted ? `"${m.title}" was stopped by the budget guard; remaining tasks did not run.` : `"${m.title}" has used ${pct(ratio)} of its $${m.budgetUsd} budget and will be stopped if it reaches 100%.`,
        evidence: [{ kind: "mission", id: m.id, label: m.title, detail: `$${m.costUsd.toFixed(4)} of $${m.budgetUsd} (estimated)` }, { kind: "config", id: "budgetWarnRatio", label: "warning ratio", detail: pct(t.budgetWarnRatio) }],
        facts: { costUsd: m.costUsd, budgetUsd: m.budgetUsd, ratio, estimated: true },
        nextAction: exhausted ? "Decide whether to replan with a larger budget." : "Pause the mission if the remaining work is not worth the spend.",
        requiresHuman: exhausted,
      });
    }
    return out;
  },
};

const repairsExhausted: Rule = {
  id: "mission.repairs_exhausted",
  version: 1,
  category: "mission",
  title: "Repair attempts exhausted",
  definition: {
    evidence: "Mission repairRounds/maxRepairs and MissionFinding rows marked UNRESOLVED.",
    trigger: "At least one UNRESOLVED blocking finding (the engine marks these when the repair limit is reached).",
    severity: "high — automatic repair has stopped and the mission cannot complete.",
    dedupe: "One finding per mission.",
    resolution: "No UNRESOLVED blocking findings remain for the mission.",
    falsePositives: "None expected — the engine sets UNRESOLVED only at the limit.",
    humanAction: "Yes — automatic repair has stopped by design.",
  },
  evaluate(s) {
    const out: RuleOutcome[] = [];
    for (const m of activeMissions(s)) {
      const unresolved = s.blockingReviewFindings.filter((f) => f.missionId === m.id && f.status === "UNRESOLVED");
      if (!unresolved.length) {
        out.push({ kind: "clear", resource: missionRes(m), reason: "no unresolved blocking findings" });
        continue;
      }
      out.push({
        kind: "fire",
        resource: missionRes(m),
        severity: "high",
        severityReason: `${unresolved.length} blocking finding(s) unresolved after ${m.repairRounds}/${m.maxRepairs} repair rounds`,
        certainty: "confirmed",
        title: `Repairs exhausted with ${unresolved.length} unresolved finding(s)`,
        explanation: `"${m.title}" used all ${m.maxRepairs} repair rounds; the remaining findings need a person.`,
        evidence: unresolved.map((f) => ({ kind: "finding" as const, id: f.id, label: f.code, detail: `${f.severity} ${f.title}` })),
        facts: { unresolved: unresolved.length, repairRounds: m.repairRounds, maxRepairs: m.maxRepairs },
        nextAction: "Start a bounded investigation mission or replan with a different approach.",
        requiresHuman: true,
      });
    }
    return out;
  },
};

const missionFailed: Rule = {
  id: "mission.failed",
  version: 1,
  category: "mission",
  title: "Mission failed — needs intervention",
  definition: {
    evidence: "Mission status FAILED (within the last 7 days) and the FAILED required task with its latest run and error category.",
    trigger: "Mission FAILED and at least one required task FAILED. Budget stops are covered by mission.budget and excluded here.",
    severity: "high; medium when the failing task's error is transient (a retry is likely to work).",
    dedupe: "One finding per mission.",
    resolution: "Mission COMPLETED or CANCELLED, or — after a retry — every task that failed has a later successful run. A retried mission that is merely RUNNING again stays open (recovery not yet proven).",
    falsePositives: "A deliberate rejection by a person (approval_rejected) is low severity — it is a decision, not a fault.",
    humanAction: "Yes — a failed mission does not restart by itself.",
  },
  evaluate(s) {
    const out: RuleOutcome[] = [];
    const TRANSIENT = ["tool_timeout", "tool_execution_error", "worker_lost", "provider_error", "invalid_structured_output", "sandbox_failure"];
    for (const m of activeMissions(s)) {
      const res = missionRes(m);
      const recent = minutes(s.now, m.updatedAt) < 7 * 24 * 60;
      if (m.status !== "FAILED" || !recent || /budget/i.test(m.statusReason)) {
        if (["RUNNING", "READY", "PAUSED"].includes(m.status)) {
          // Re-opened by a retry: resolved only once each previously failed task has succeeded since.
          const runs = s.runs.filter((r) => r.missionId === m.id);
          const failedKeys = [...new Set(runs.filter((r) => r.status === "FAILED").map((r) => r.taskKey))];
          const recovered = failedKeys.filter((k) => {
            const lastFail = Math.max(...runs.filter((r) => r.taskKey === k && r.status === "FAILED").map((r) => r.startedAt.getTime()));
            return runs.some((r) => r.taskKey === k && r.status === "SUCCEEDED" && r.startedAt.getTime() > lastFail);
          });
          if (failedKeys.length && recovered.length < failedKeys.length) {
            out.push({ kind: "unknown", resource: res, reason: `recovery in progress: ${failedKeys.filter((k) => !recovered.includes(k)).join(", ")} not yet re-run successfully` });
            continue;
          }
          out.push({ kind: "clear", resource: res, reason: failedKeys.length ? `recovered: ${recovered.join(", ")} succeeded after the failure` : `mission is ${m.status.toLowerCase()}` });
          continue;
        }
        out.push({ kind: "clear", resource: res, reason: `mission is ${m.status.toLowerCase()}` });
        continue;
      }
      const failedTasks = s.tasks.filter((t) => t.missionId === m.id && t.status === "FAILED");
      if (!failedTasks.length) {
        out.push({ kind: "unknown", resource: res, reason: "mission failed but no failed task is recorded" });
        continue;
      }
      const t = failedTasks[0];
      const lastRun = s.runs.filter((r) => r.missionId === m.id && r.taskKey === t.key).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
      const transient = TRANSIENT.includes(t.errorCategory ?? "");
      const rejected = t.errorCategory === "approval_rejected";
      out.push({
        kind: "fire",
        resource: res,
        severity: rejected ? "low" : transient ? "medium" : "high",
        severityReason: rejected ? "a person rejected the gate" : transient ? `${t.errorCategory} is usually transient` : `${t.errorCategory ?? "unknown"} failure`,
        certainty: "confirmed",
        title: `Mission failed at "${t.key}" (${t.errorCategory ?? "unknown error"})`,
        explanation: `"${m.title}" stopped because the required task "${t.title}" failed${transient ? " with an error that a retry often clears" : ""}.`,
        evidence: [{ kind: "mission", id: m.id, label: m.title, detail: m.statusReason.slice(0, 200) }, { kind: "task", id: t.id, label: t.key, detail: t.errorCategory ?? "" }, ...(lastRun ? [{ kind: "run" as const, id: lastRun.id, label: `${t.key} run`, detail: `${lastRun.status}${lastRun.errorCategory ? ` (${lastRun.errorCategory})` : ""}` }] : [])],
        facts: { taskKey: t.key, errorCategory: t.errorCategory, transient },
        nextAction: transient ? `Retry "${t.key}" — the failure looks transient.` : rejected ? "Replan if the change is still wanted." : "Inspect the failed run's evidence before retrying.",
        requiresHuman: !rejected,
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Agent health
// ---------------------------------------------------------------------------

function agentRate(s: OpsSnapshot, rule: Pick<Rule, "id">, test: (r: SnapRun) => boolean, minSample: number, rate: number, label: string, category: string): RuleOutcome[] {
  const out: RuleOutcome[] = [];
  const evaluated = s.runs.filter((r) => ["SUCCEEDED", "FAILED"].includes(r.status));
  for (const agentKey of [...new Set(evaluated.map((r) => r.agentKey))]) {
    const mine = evaluated.filter((r) => r.agentKey === agentKey);
    const res: Resource = { type: "agent", id: agentKey, label: agentKey };
    if (mine.length < minSample) {
      out.push({ kind: "unknown", resource: res, reason: `${mine.length} evaluated runs (< ${minSample}) — not enough evidence` });
      continue;
    }
    const bad = mine.filter(test);
    const r = bad.length / mine.length;
    if (r < rate) {
      out.push({ kind: "clear", resource: res, reason: `${pct(r)} ${label} (< ${pct(rate)})` });
      continue;
    }
    out.push({
      kind: "fire",
      resource: res,
      severity: r >= 0.75 ? "high" : "medium",
      severityReason: `${bad.length}/${mine.length} runs (${pct(r)}) vs threshold ${pct(rate)}`,
      certainty: mine.length < 2 * minSample ? "suspicion" : "confirmed",
      title: `${agentKey}: ${pct(r)} of runs ${label}`,
      explanation: `${bad.length} of the last ${mine.length} evaluated runs by ${agentKey} ended in ${category}.`,
      evidence: bad.slice(-5).map((x) => ({ kind: "run" as const, id: x.id, label: `${x.taskKey} run`, detail: x.errorCategory ?? x.outcome })),
      facts: { bad: bad.length, sample: mine.length, rate: r, threshold: rate, ruleId: rule.id },
      nextAction: category === "invalid_structured_output" ? "Re-run the agent's evaluation and inspect its output contract violations." : "Inspect the failing runs' tool calls and timeouts.",
      requiresHuman: false,
    });
  }
  return out;
}

const agentInvalidOutput: Rule = {
  id: "agent.invalid_output",
  version: 1,
  category: "agent",
  title: "Agent repeatedly returns invalid structured output",
  definition: {
    evidence: "MissionTaskRun.errorCategory = invalid_structured_output over the agent's evaluated runs (succeeded or failed).",
    trigger: "Rate ≥ `invalidOutputRate` over ≥ `invalidOutputMinSample` runs.",
    severity: "medium; high at ≥ 75%. Certainty is 'suspicion' below 2× the minimum sample.",
    dedupe: "One finding per agent.",
    resolution: "Rate falls below the threshold.",
    falsePositives: "Injected faults in tests; small samples → unknown.",
    humanAction: "No — informational; re-run the agent's evaluation to confirm.",
  },
  evaluate: (s, t) => agentRate(s, agentInvalidOutput, (r) => r.errorCategory === "invalid_structured_output", t.invalidOutputMinSample, t.invalidOutputRate, "returned invalid output", "invalid_structured_output"),
};

const agentTimeouts: Rule = {
  id: "agent.timeouts",
  version: 1,
  category: "agent",
  title: "Agent has a high timeout rate",
  definition: {
    evidence: "MissionTaskRun.errorCategory in (tool_timeout, model_timeout, worker_lost).",
    trigger: "Rate ≥ `timeoutRate` over ≥ `timeoutMinSample` evaluated runs.",
    severity: "medium; high at ≥ 75%.",
    dedupe: "One finding per agent.",
    resolution: "Rate falls below the threshold.",
    falsePositives: "A single slow dependency inflates the rate — see the tool-failure rule for the cause.",
    humanAction: "No — informational; check the slow dependency.",
  },
  evaluate: (s, t) => agentRate(s, agentTimeouts, (r) => ["tool_timeout", "model_timeout", "worker_lost"].includes(r.errorCategory ?? ""), t.timeoutMinSample, t.timeoutRate, "timed out", "a timeout"),
};

const toolFailures: Rule = {
  id: "tool.failures",
  version: 1,
  category: "agent",
  title: "A tool fails repeatedly",
  definition: {
    evidence: "ToolCall rows (status) in the recent window, excluding permission denials (those are correct behaviour).",
    trigger: "Failure rate ≥ `toolFailureRate` over ≥ `toolFailureMinSample` calls for one tool.",
    severity: "medium; high at ≥ 75%.",
    dedupe: "One finding per tool.",
    resolution: "Rate falls below the threshold.",
    falsePositives: "Intentional negative tests; denials are excluded.",
    humanAction: "No — check the backing service.",
  },
  evaluate(s, t) {
    const out: RuleOutcome[] = [];
    const calls = s.toolCalls.filter((c) => c.status !== "denied" && c.status !== "out_of_scope" && c.status !== "approval_required");
    for (const tool of [...new Set(calls.map((c) => c.tool))]) {
      const mine = calls.filter((c) => c.tool === tool);
      const res: Resource = { type: "tool", id: tool, label: tool };
      if (mine.length < t.toolFailureMinSample) {
        out.push({ kind: "unknown", resource: res, reason: `${mine.length} calls (< ${t.toolFailureMinSample})` });
        continue;
      }
      const bad = mine.filter((c) => c.status !== "ok");
      const r = bad.length / mine.length;
      if (r < t.toolFailureRate) {
        out.push({ kind: "clear", resource: res, reason: `${pct(r)} failures` });
        continue;
      }
      out.push({
        kind: "fire",
        resource: res,
        severity: r >= 0.75 ? "high" : "medium",
        severityReason: `${bad.length}/${mine.length} calls failed`,
        certainty: "confirmed",
        title: `Tool ${tool} failing ${pct(r)} of calls`,
        explanation: `${bad.length} of ${mine.length} recent ${tool} calls ended ${[...new Set(bad.map((b) => b.status))].join("/")}.`,
        evidence: bad.slice(-5).map((c) => ({ kind: "tool_call" as const, id: c.id, label: tool, detail: c.status })),
        facts: { failures: bad.length, sample: mine.length, statuses: [...new Set(bad.map((b) => b.status))] },
        nextAction: "Check the tool's backing service (sandbox for test.run / sandbox.exec).",
        requiresHuman: false,
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Engineering health
// ---------------------------------------------------------------------------

const testSuiteFailing: Rule = {
  id: "engineering.tests_failing",
  version: 1,
  category: "engineering",
  title: "Test suite failing with no passing run since",
  definition: {
    evidence: "Latest TEST-kind run per active mission (Docker-executed test results).",
    trigger: "Latest test run failed (tests_failed or FAILED) and the mission is FAILED or still active.",
    severity: "high when the mission has FAILED; medium while repair is still possible.",
    dedupe: "One finding per mission.",
    resolution: "A later test run passed, or the mission was cancelled.",
    falsePositives: "A repair in flight — severity is medium until the mission fails.",
    humanAction: "When the mission has failed.",
  },
  evaluate(s) {
    const out: RuleOutcome[] = [];
    for (const m of activeMissions(s)) {
      const tests = s.runs.filter((r) => r.missionId === m.id && r.taskKind === "TEST").sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
      const res = missionRes(m);
      if (!tests.length) {
        out.push({ kind: "clear", resource: res, reason: "no test runs" });
        continue;
      }
      const last = tests[tests.length - 1];
      const failed = last.status === "FAILED" || last.outcome === "tests_failed";
      if (!failed || m.status === "CANCELLED") {
        out.push({ kind: "clear", resource: res, reason: failed ? "mission cancelled" : "latest test run passed" });
        continue;
      }
      if (last.errorCategory === "sandbox_failure") {
        out.push({ kind: "unknown", resource: res, reason: "tests could not execute (sandbox unavailable) — not a test failure" });
        continue;
      }
      const dead = m.status === "FAILED";
      out.push({
        kind: "fire",
        resource: res,
        severity: dead ? "high" : "medium",
        severityReason: dead ? "mission failed with failing tests" : "repair still possible",
        certainty: "confirmed",
        title: `Tests failing in "${m.title}"`,
        explanation: "The most recent sandbox test run of this mission failed.",
        evidence: [{ kind: "run", id: last.id, label: `${last.taskKey} run`, detail: last.outcome || last.status }],
        facts: { missionStatus: m.status, outcome: last.outcome },
        nextAction: "Inspect the failing test cases in the run evidence.",
        requiresHuman: dead,
      });
    }
    return out;
  },
};

const blockingReviewDefect: Rule = {
  id: "engineering.blocking_review_defect",
  version: 1,
  category: "engineering",
  title: "Blocking review defect open",
  definition: {
    evidence: "MissionFinding rows (reviewer/QA/security) that are blocking, supported by executed evidence, and OPEN.",
    trigger: "Any such finding on a non-terminal mission.",
    severity: "Mapped from the finding: CRITICAL→critical, HIGH→high, else medium.",
    dedupe: "One finding per review finding.",
    resolution: "Review finding RESOLVED, or the mission is terminal.",
    falsePositives: "Unsupported concerns are excluded by construction.",
    humanAction: "No — the repair loop addresses it; escalates via repairs_exhausted.",
  },
  evaluate(s) {
    const out: RuleOutcome[] = [];
    for (const f of s.blockingReviewFindings) {
      const m = s.missions.find((x) => x.id === f.missionId);
      if (!m || m.source === "SEEDED") continue;
      const res: Resource = { type: "mission", id: `${f.missionId}:${f.code}`, label: `${f.code} in "${m.title}"`, missionId: f.missionId };
      if (f.status !== "OPEN" || ["COMPLETED", "FAILED", "CANCELLED"].includes(m.status)) {
        out.push({ kind: "clear", resource: res, reason: `finding ${f.status.toLowerCase()}, mission ${m.status.toLowerCase()}` });
        continue;
      }
      out.push({
        kind: "fire",
        resource: res,
        severity: f.severity === "CRITICAL" ? "critical" : f.severity === "HIGH" ? "high" : "medium",
        severityReason: `review finding severity ${f.severity}`,
        certainty: "confirmed",
        title: `${f.code}: ${f.title}`,
        explanation: `An evidence-backed blocking defect is open in "${m.title}".`,
        evidence: [{ kind: "finding", id: f.id, label: f.code, detail: f.title }],
        facts: { code: f.code, severity: f.severity },
        nextAction: "Let the mission's repair loop run, or inspect the evidence.",
        requiresHuman: false,
      });
    }
    return out;
  },
};

const deploymentFailed: Rule = {
  id: "engineering.deployment_failed",
  version: 1,
  category: "engineering",
  title: "Latest deployment failed a pipeline stage",
  definition: {
    evidence: "Latest Deployment row per environment with its stage results (simulated pipeline).",
    trigger: "Latest deployment status FAILED.",
    severity: "high for production, medium otherwise.",
    dedupe: "One finding per environment.",
    resolution: "A later deployment to that environment succeeded, or it was rolled back.",
    falsePositives: "The pipeline is simulated; the finding is labelled as such.",
    humanAction: "Production: yes.",
  },
  evaluate(s) {
    const out: RuleOutcome[] = [];
    for (const env of [...new Set(s.deployments.map((d) => d.env))]) {
      const latest = s.deployments.filter((d) => d.env === env && d.status !== "PENDING_APPROVAL").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      const res: Resource = { type: "deployment", id: env, label: `${env} deployments` };
      if (!latest) continue;
      if (latest.status !== "FAILED") {
        out.push({ kind: "clear", resource: res, reason: `latest ${env} deployment ${latest.status.toLowerCase()}` });
        continue;
      }
      out.push({
        kind: "fire",
        resource: res,
        severity: env === "production" ? "high" : "medium",
        severityReason: `${env} environment`,
        certainty: "confirmed",
        title: `${env} deploy ${latest.version} failed at ${latest.failedStage ?? "an unknown stage"}`,
        explanation: `The latest ${env} release failed its ${latest.failedStage?.toLowerCase().replace(/_/g, " ") ?? ""} stage (simulated pipeline).`,
        evidence: [{ kind: "deployment", id: latest.id, label: latest.version, detail: `failed at ${latest.failedStage}` }],
        facts: { env, version: latest.version, failedStage: latest.failedStage, simulated: true },
        nextAction: env === "production" ? "Roll back or redeploy after review (requires approval)." : "Roll back the simulated deployment or redeploy.",
        requiresHuman: env === "production",
      });
    }
    return out;
  },
};

const integrationUnavailable: Rule = {
  id: "engineering.integration_unavailable",
  version: 1,
  category: "engineering",
  title: "Integration unavailable",
  definition: {
    evidence: "Live probe of the Docker sandbox and model provider mode at evaluation time.",
    trigger: "Sandbox probe failed (tests cannot run → results become UNVERIFIED). Model provider in simulation mode is reported as info, not a failure.",
    severity: "high for the sandbox.",
    dedupe: "One finding per integration.",
    resolution: "Probe succeeds.",
    falsePositives: "Docker starting up; the next evaluation clears it.",
    humanAction: "Yes — start Docker.",
  },
  evaluate(s) {
    const out: RuleOutcome[] = [];
    for (const i of s.integrations) {
      const res: Resource = { type: "integration", id: i.id, label: i.label };
      if (i.available === null) {
        out.push({ kind: "unknown", resource: res, reason: "not probed" });
        continue;
      }
      if (i.available || i.id === "model") {
        out.push({ kind: "clear", resource: res, reason: i.detail });
        continue;
      }
      out.push({
        kind: "fire",
        resource: res,
        severity: "high",
        severityReason: "verification depends on it",
        certainty: "confirmed",
        title: `${i.label} unavailable`,
        explanation: `${i.detail}. Code tasks will be marked UNVERIFIED until it is back.`,
        evidence: [{ kind: "config", id: i.id, label: i.label, detail: i.detail }],
        facts: { integration: i.id },
        nextAction: "Start Docker, then re-evaluate.",
        requiresHuman: true,
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Evaluation health
// ---------------------------------------------------------------------------

function comparable(evals: SnapEvaluation[], t: Thresholds) {
  return evals.filter((e) => e.status === "COMPLETED" && e.total >= t.evalMinCases);
}

const evaluationRegression: Rule = {
  id: "evaluation.regression",
  version: 1,
  category: "evaluation",
  title: "Evaluation pass rate regressed",
  definition: {
    evidence: "Completed Evaluation rows for the same agent + dataset + mode, each with ≥ `evalMinCases` cases.",
    trigger: "Latest pass rate is ≥ `evalRegressionDrop` below the previous comparable run AND the latest run used a different prompt version or model (a change, not noise). Same config → reported as a suspicion.",
    severity: "high when it also falls below the 0.8 release gate; else medium. Suspicions are low.",
    dedupe: "One finding per (agent, dataset, mode).",
    resolution: "A later comparable run recovers to within the drop threshold.",
    falsePositives: "Simulation-mode fixtures measure the harness; the finding notes the mode. Fewer than two comparable runs → unknown.",
    humanAction: "No — but promotion should be blocked (existing gates do this).",
  },
  evaluate(s, t) {
    const out: RuleOutcome[] = [];
    const groups = new Map<string, SnapEvaluation[]>();
    for (const e of comparable(s.evaluations, t)) groups.set(`${e.agentKey}|${e.datasetId}|${e.mode}`, [...(groups.get(`${e.agentKey}|${e.datasetId}|${e.mode}`) ?? []), e]);
    for (const [key, list] of groups) {
      const [agentKey, datasetId, mode] = key.split("|");
      const res: Resource = { type: "evaluation", id: key, label: `${agentKey} on ${datasetId} (${mode})` };
      const sorted = [...list].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
      if (sorted.length < 2) {
        out.push({ kind: "unknown", resource: res, reason: "fewer than two comparable completed runs — no baseline" });
        continue;
      }
      const [prev, last] = sorted.slice(-2);
      const drop = prev.passRate - last.passRate;
      if (drop < t.evalRegressionDrop) {
        out.push({ kind: "clear", resource: res, reason: `latest ${pct(last.passRate)} vs previous ${pct(prev.passRate)}` });
        continue;
      }
      const changed = prev.promptVersion !== last.promptVersion || prev.model !== last.model;
      const belowGate = last.passRate < 0.8;
      out.push({
        kind: "fire",
        resource: res,
        severity: !changed ? "low" : belowGate ? "high" : "medium",
        severityReason: `${pct(prev.passRate)} → ${pct(last.passRate)}${changed ? ` after ${prev.promptVersion !== last.promptVersion ? `prompt v${prev.promptVersion}→v${last.promptVersion}` : `model ${prev.model}→${last.model}`}` : " with the same prompt and model"}${belowGate ? "; below the 80% release gate" : ""}`,
        certainty: changed ? "confirmed" : "suspicion",
        title: `${agentKey} pass rate fell ${pct(drop)} on ${datasetId}`,
        explanation: changed ? "A configuration change coincides with a reproducible drop on the same dataset." : "Pass rate dropped without a configuration change — possible noise; re-run to confirm.",
        evidence: [{ kind: "evaluation", id: prev.id, label: "previous run", detail: `${pct(prev.passRate)} over ${prev.total} cases, prompt v${prev.promptVersion}, ${prev.model}` }, { kind: "evaluation", id: last.id, label: "latest run", detail: `${pct(last.passRate)} over ${last.total} cases, prompt v${last.promptVersion}, ${last.model}` }],
        facts: { previous: prev.passRate, latest: last.passRate, drop, configChanged: changed, mode },
        nextAction: changed ? "Re-run the evaluation; roll back the prompt version if confirmed." : "Re-run the evaluation to confirm.",
        requiresHuman: false,
      });
    }
    return out;
  },
};

const costPerSuccess: Rule = {
  id: "evaluation.cost_per_success",
  version: 1,
  category: "evaluation",
  title: "Cost per successful task increased",
  definition: {
    evidence: "MissionTaskRun cost and outcome per agent, split into the older and newer half of the window.",
    trigger: "Newer half cost/success exceeds older half by ≥ `costPerSuccessIncrease`, with ≥ `costMinSuccesses` successes in each half.",
    severity: "low (cost is estimated; never escalated).",
    dedupe: "One finding per agent.",
    resolution: "Increase falls below the threshold.",
    falsePositives: "Estimated costs in simulation mode; task mix changes. Small samples → unknown.",
    humanAction: "No — informational (estimated costs).",
  },
  evaluate(s, t) {
    const out: RuleOutcome[] = [];
    const evaluated = s.runs.filter((r) => ["SUCCEEDED", "FAILED"].includes(r.status)).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    for (const agentKey of [...new Set(evaluated.map((r) => r.agentKey))]) {
      const mine = evaluated.filter((r) => r.agentKey === agentKey);
      const res: Resource = { type: "agent", id: `${agentKey}:cost`, label: agentKey };
      const half = Math.floor(mine.length / 2);
      const [a, b] = [mine.slice(0, half), mine.slice(half)];
      const succ = (xs: SnapRun[]) => xs.filter((r) => r.status === "SUCCEEDED").length;
      if (succ(a) < t.costMinSuccesses || succ(b) < t.costMinSuccesses) {
        out.push({ kind: "unknown", resource: res, reason: `not enough successes per window (${succ(a)}/${succ(b)}, need ${t.costMinSuccesses})` });
        continue;
      }
      const cps = (xs: SnapRun[]) => xs.reduce((n, r) => n + r.costUsd, 0) / succ(xs);
      const [ca, cb] = [cps(a), cps(b)];
      const inc = ca > 0 ? (cb - ca) / ca : 0;
      if (inc < t.costPerSuccessIncrease) {
        out.push({ kind: "clear", resource: res, reason: `cost/success change ${pct(inc)}` });
        continue;
      }
      out.push({
        kind: "fire",
        resource: res,
        severity: "low",
        severityReason: "estimated cost; informational",
        certainty: "warning",
        title: `${agentKey}: cost per success up ${pct(inc)}`,
        explanation: `Estimated cost per successful task rose from $${ca.toFixed(4)} to $${cb.toFixed(4)}.`,
        evidence: b.slice(-3).map((r) => ({ kind: "run" as const, id: r.id, label: `${r.taskKey} run`, detail: `$${r.costUsd.toFixed(4)}` })),
        facts: { before: ca, after: cb, increase: inc, estimated: true },
        nextAction: "Check whether the task mix or context size changed.",
        requiresHuman: false,
      });
    }
    return out;
  },
};

export const RULES: Rule[] = [
  missionBlocked,
  taskOverrun,
  repeatedVerificationFailure,
  budgetThreshold,
  repairsExhausted,
  missionFailed,
  agentInvalidOutput,
  agentTimeouts,
  toolFailures,
  testSuiteFailing,
  blockingReviewDefect,
  deploymentFailed,
  integrationUnavailable,
  evaluationRegression,
  costPerSuccess,
];

export function ruleById(id: string): Rule | undefined {
  return RULES.find((r) => r.id === id);
}

export function dedupeKeyFor(ruleId: string, resource: Resource) {
  return `${ruleId}:${resource.type}:${resource.id}`;
}

/** Run every rule over a snapshot. Pure. */
export function evaluateRules(s: OpsSnapshot, t: Thresholds = DEFAULT_THRESHOLDS): { rule: Rule; outcome: RuleOutcome }[] {
  return RULES.flatMap((rule) => rule.evaluate(s, t).map((outcome) => ({ rule, outcome })));
}
