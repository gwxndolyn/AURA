/**
 * Synthetic operational scenarios for measuring detection quality.
 *
 * Each scenario is a hand-built OpsSnapshot plus the findings a correct rule
 * set must (and must not) produce. They exercise the pure rules engine only —
 * results describe behaviour on these fixtures, not production accuracy.
 */
import type { OpsSnapshot, SnapMission, SnapRun, SnapTask, SnapEvaluation } from "./rules";

const NOW = new Date("2026-10-19T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

const empty = (): OpsSnapshot => ({ now: NOW, missions: [], tasks: [], runs: [], approvals: [], toolCalls: [], deployments: [], evaluations: [], integrations: [{ id: "sandbox", label: "Docker sandbox", available: true, detail: "docker reachable" }], blockingReviewFindings: [] });
const mission = (id: string, over: Partial<SnapMission> = {}): SnapMission => ({ id, title: `Mission ${id}`, status: "RUNNING", source: "USER", costUsd: 0.1, budgetUsd: 1, repairRounds: 0, maxRepairs: 2, statusReason: "", updatedAt: ago(5), ...over });
const run = (id: string, over: Partial<SnapRun> = {}): SnapRun => ({ id, missionId: "m1", taskKey: "verify", taskKind: "TEST", agentKey: "qa-engineer", status: "SUCCEEDED", outcome: "passed", errorCategory: null, outputValid: true, costUsd: 0.001, startedAt: ago(10), ...over });
const task = (id: string, over: Partial<SnapTask> = {}): SnapTask => ({ id, missionId: "m1", key: "fix", title: "Fix", kind: "CODE_CHANGE", agentKey: "backend-engineer", status: "SUCCEEDED", errorCategory: null, startedAt: ago(10), leaseExpiresAt: null, maxDurationMs: 120_000, ...over });
const evaluation = (id: string, over: Partial<SnapEvaluation> = {}): SnapEvaluation => ({ id, agentKey: "qa-engineer", datasetId: "qa-engineer", mode: "live", label: "baseline", status: "COMPLETED", total: 6, passRate: 1, promptKey: "agent.qa-engineer.system", promptVersion: 1, model: "m", startedAt: ago(100), ...over });

export interface Scenario {
  id: string;
  description: string;
  snapshot: OpsSnapshot;
  /** dedupe keys (ruleId:type:id) that MUST fire. */
  expect: string[];
  /** rule ids that must NOT fire for any resource. */
  forbid?: string[];
  /** rule ids that must report "unknown" (insufficient evidence). */
  unknown?: string[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: "blocked-mission",
    description: "A mission waiting on plan approval for 3 hours.",
    snapshot: { ...empty(), missions: [mission("m1", { status: "AWAITING_APPROVAL", updatedAt: ago(180) })] },
    expect: ["mission.blocked:mission:m1"],
  },
  {
    id: "recently-blocked",
    description: "Waiting 10 minutes — below threshold, must not fire.",
    snapshot: { ...empty(), missions: [mission("m1", { status: "AWAITING_APPROVAL", updatedAt: ago(10) })] },
    expect: [],
    forbid: ["mission.blocked"],
  },
  {
    id: "transient-timeout-recovered",
    description: "A tool timeout on attempt 1 followed by a successful retry: latest run passed, no active alert.",
    snapshot: { ...empty(), missions: [mission("m1")], runs: [run("r1", { status: "FAILED", outcome: "tool_timeout", errorCategory: "tool_timeout", startedAt: ago(20) }), run("r2", { startedAt: ago(10) })] },
    expect: [],
    forbid: ["mission.repeated_verification_failure", "engineering.tests_failing", "agent.timeouts"],
  },
  {
    id: "repeated-verification-failure",
    description: "QA fails twice on the same task.",
    snapshot: { ...empty(), missions: [mission("m1", { repairRounds: 1 })], runs: [run("r1", { outcome: "tests_failed", startedAt: ago(20) }), run("r2", { outcome: "tests_failed", startedAt: ago(10) })] },
    expect: ["mission.repeated_verification_failure:task:m1:verify", "engineering.tests_failing:mission:m1"],
  },
  {
    id: "budget-crossing",
    description: "Running mission at 85% of budget.",
    snapshot: { ...empty(), missions: [mission("m1", { costUsd: 0.85, budgetUsd: 1 })] },
    expect: ["mission.budget:mission:m1"],
  },
  {
    id: "budget-under",
    description: "Running mission at 50% of budget — no alert.",
    snapshot: { ...empty(), missions: [mission("m1", { costUsd: 0.5, budgetUsd: 1 })] },
    expect: [],
    forbid: ["mission.budget"],
  },
  {
    id: "lost-worker",
    description: "Task RUNNING with an expired lease.",
    snapshot: { ...empty(), missions: [mission("m1")], tasks: [task("t1", { status: "RUNNING", startedAt: ago(3), leaseExpiresAt: ago(1) })] },
    expect: ["task.overrun:task:t1"],
  },
  {
    id: "task-no-duration",
    description: "Running task whose agent has no declared max duration — unknown, not raised.",
    snapshot: { ...empty(), missions: [mission("m1")], tasks: [task("t1", { status: "RUNNING", startedAt: ago(60), maxDurationMs: null })] },
    expect: [],
    forbid: ["task.overrun"],
    unknown: ["task.overrun"],
  },
  {
    id: "duplicate-events",
    description: "The same two failing runs presented twice — still one finding per resource.",
    snapshot: { ...empty(), missions: [mission("m1")], runs: [run("r1", { outcome: "tests_failed", startedAt: ago(20) }), run("r2", { outcome: "tests_failed", startedAt: ago(10) }), run("r1", { outcome: "tests_failed", startedAt: ago(20) }), run("r2", { outcome: "tests_failed", startedAt: ago(10) })] },
    expect: ["mission.repeated_verification_failure:task:m1:verify", "engineering.tests_failing:mission:m1"],
  },
  {
    id: "sandbox-down-not-a-test-failure",
    description: "Tests could not run (sandbox down): no test-failure diagnosis; the integration finding fires instead.",
    snapshot: { ...empty(), missions: [mission("m1", { status: "FAILED" })], runs: [run("r1", { status: "FAILED", outcome: "unverified", errorCategory: "sandbox_failure" })], integrations: [{ id: "sandbox", label: "Docker sandbox", available: false, detail: "Docker daemon not reachable" }] },
    expect: ["engineering.integration_unavailable:integration:sandbox"],
    forbid: ["engineering.tests_failing"],
    unknown: ["engineering.tests_failing"],
  },
  {
    id: "agent-regression-sufficient",
    description: "qa-engineer evaluation drops 100% → 50% after a prompt change, 6 cases each.",
    snapshot: { ...empty(), evaluations: [evaluation("e1"), evaluation("e2", { passRate: 0.5, promptVersion: 2, startedAt: ago(10) })] },
    expect: ["evaluation.regression:evaluation:qa-engineer|qa-engineer|live"],
  },
  {
    id: "agent-regression-insufficient",
    description: "Only one comparable evaluation, or too few cases — explicit unknown.",
    snapshot: { ...empty(), evaluations: [evaluation("e1"), evaluation("e2", { passRate: 0.2, total: 2, startedAt: ago(10) })] },
    expect: [],
    forbid: ["evaluation.regression"],
    unknown: ["evaluation.regression"],
  },
  {
    id: "invalid-output-small-sample",
    description: "3 of 3 runs invalid — below the minimum sample, unknown.",
    snapshot: { ...empty(), missions: [mission("m1")], runs: [1, 2, 3].map((i) => run(`r${i}`, { agentKey: "architect", taskKey: "architecture", taskKind: "ARCHITECTURE", status: "FAILED", outcome: "invalid_structured_output", errorCategory: "invalid_structured_output", startedAt: ago(10 + i) })) },
    expect: [],
    forbid: ["agent.invalid_output"],
    unknown: ["agent.invalid_output"],
  },
  {
    id: "invalid-output-sufficient",
    description: "8 of 10 architect runs invalid.",
    snapshot: { ...empty(), missions: [mission("m1")], runs: Array.from({ length: 10 }, (_, i) => run(`r${i}`, { agentKey: "architect", taskKey: "architecture", taskKind: "ARCHITECTURE", status: i < 8 ? "FAILED" : "SUCCEEDED", outcome: i < 8 ? "invalid_structured_output" : "proposal", errorCategory: i < 8 ? "invalid_structured_output" : null, startedAt: ago(30 - i) })) },
    expect: ["agent.invalid_output:agent:architect"],
  },
  {
    id: "mission-failed-transient",
    description: "Mission FAILED because a required task hit a tool timeout.",
    snapshot: { ...empty(), missions: [mission("m1", { status: "FAILED", statusReason: "Required task did not succeed: Architecture" })], tasks: [task("t1", { key: "architecture", status: "FAILED", errorCategory: "tool_timeout" })] },
    expect: ["mission.failed:mission:m1"],
  },
  {
    id: "retried-mission-not-yet-recovered",
    description: "After a retry the mission is RUNNING again but the failed task has not succeeded yet: no resolution, explicit unknown.",
    snapshot: { ...empty(), missions: [mission("m1", { status: "RUNNING" })], runs: [run("r1", { taskKey: "architecture", taskKind: "ARCHITECTURE", agentKey: "architect", status: "FAILED", outcome: "tool_timeout", errorCategory: "tool_timeout" })] },
    expect: [],
    forbid: ["mission.failed"],
    unknown: ["mission.failed"],
  },
  {
    id: "mission-failed-budget-not-double-counted",
    description: "A budget stop is reported by the budget rule only.",
    snapshot: { ...empty(), missions: [mission("m1", { status: "FAILED", statusReason: "Mission budget exhausted ($1.1 of $1)", costUsd: 1.1, budgetUsd: 1 })] },
    expect: ["mission.budget:mission:m1"],
    forbid: ["mission.failed"],
  },
  {
    id: "seeded-sample-ignored",
    description: "Read-only sample missions never raise findings.",
    snapshot: { ...empty(), missions: [mission("s1", { source: "SEEDED", status: "AWAITING_APPROVAL", updatedAt: ago(500) })] },
    expect: [],
    forbid: ["mission.blocked"],
  },
  {
    id: "failed-deploy-staging",
    description: "Latest staging deployment failed at TEST.",
    snapshot: { ...empty(), deployments: [{ id: "d1", env: "staging", version: "v0.1.0", status: "SUCCESS", failedStage: null, createdAt: ago(60) }, { id: "d2", env: "staging", version: "v0.2.0", status: "FAILED", failedStage: "TEST", createdAt: ago(5) }] },
    expect: ["engineering.deployment_failed:deployment:staging"],
  },
];
