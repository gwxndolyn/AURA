/**
 * Company performance metrics. OPERATIONAL metrics come from persisted
 * records only; each states its definition, source, window and sample size,
 * and is null ("insufficient data") rather than a guess. Sample missions are
 * excluded. Simulated metrics live on TwinRun results and are labelled there.
 */
import { prisma } from "@/lib/db";

export interface Metric {
  key: string;
  label: string;
  kind: "operational" | "simulated";
  value: number | null;
  unit: "count" | "ratio" | "usd" | "hours";
  definition: string;
  source: string;
  window: string;
  sample: number;
  note?: string;
}

const DAYS = 30;

export async function operationalMetrics(companyId: string): Promise<Metric[]> {
  const since = new Date(Date.now() - DAYS * 864e5);
  const window = `last ${DAYS} days`;
  const where = { companyId, source: { not: "SEEDED" }, createdAt: { gte: since } };
  const [missions, runs, agents, pendingApprovals, openFindings, agentRuns] = await Promise.all([
    prisma.mission.findMany({ where, select: { id: true, status: true, costUsd: true, startedAt: true, completedAt: true } }),
    prisma.missionTaskRun.findMany({ where: { companyId, startedAt: { gte: since }, mission: { source: { not: "SEEDED" } } }, select: { agentKey: true, status: true, outcome: true, latencyMs: true, usageEstimated: true } }),
    prisma.agent.count({ where: { companyId } }),
    prisma.missionApproval.count({ where: { companyId, status: "PENDING", mission: { source: { not: "SEEDED" } } } }),
    prisma.opsFinding.count({ where: { companyId, status: { in: ["OPEN", "ACKNOWLEDGED", "INVESTIGATING"] } } }),
    prisma.agentRun.findMany({ where: { companyId, createdAt: { gte: since } }, select: { usageSource: true } }),
  ]);

  const finished = missions.filter((m) => ["COMPLETED", "FAILED"].includes(m.status));
  const completed = missions.filter((m) => m.status === "COMPLETED");
  const verify = runs.filter((r) => ["passed", "tests_failed", "approved", "changes_requested"].includes(r.outcome));
  const verifyPass = verify.filter((r) => ["passed", "approved"].includes(r.outcome));
  const busyMs = runs.reduce((n, r) => n + r.latencyMs, 0);
  const costCompleted = completed.reduce((n, m) => n + m.costUsd, 0);
  const estimated = agentRuns.some((r) => r.usageSource !== "provider");
  const leadHours = completed.filter((m) => m.startedAt && m.completedAt).map((m) => (m.completedAt!.getTime() - m.startedAt!.getTime()) / 3600_000);

  return [
    { key: "missions_completed", label: "Missions completed", kind: "operational", value: completed.length, unit: "count", definition: "Missions whose status is COMPLETED (all required tasks succeeded and no blocking finding open).", source: "Mission", window, sample: missions.length },
    { key: "mission_failure_rate", label: "Mission failure rate", kind: "operational", value: finished.length >= 3 ? (finished.length - completed.length) / finished.length : null, unit: "ratio", definition: "FAILED ÷ (COMPLETED + FAILED). Running, cancelled and awaiting missions excluded.", source: "Mission", window, sample: finished.length, note: finished.length < 3 ? "fewer than 3 finished missions" : undefined },
    { key: "verification_pass_rate", label: "Verification pass rate", kind: "operational", value: verify.length >= 3 ? verifyPass.length / verify.length : null, unit: "ratio", definition: "QA test runs and reviews that passed ÷ all QA test runs and reviews with a verdict.", source: "MissionTaskRun.outcome", window, sample: verify.length, note: verify.length < 3 ? "fewer than 3 verification runs" : undefined },
    { key: "agent_busy_hours", label: "Agent execution time", kind: "operational", value: runs.length ? busyMs / 3600_000 : null, unit: "hours", definition: "Sum of recorded task-attempt latency across all agents (not utilization: AURA has no wall-clock capacity model for agents).", source: "MissionTaskRun.latencyMs", window, sample: runs.length },
    { key: "cost_per_completed_mission", label: "Cost per completed mission", kind: "operational", value: completed.length ? costCompleted / completed.length : null, unit: "usd", definition: "Mission.costUsd summed over COMPLETED missions ÷ their count.", source: "Mission.costUsd (from AgentRun)", window, sample: completed.length, note: estimated ? "includes estimated (simulator) usage — not billed cost" : undefined },
    { key: "mission_lead_time", label: "Mission lead time (median)", kind: "operational", value: leadHours.length ? leadHours.sort((a, b) => a - b)[Math.floor(leadHours.length / 2)] : null, unit: "hours", definition: "Median startedAt → completedAt for COMPLETED missions.", source: "Mission", window, sample: leadHours.length },
    { key: "pending_approvals", label: "Outstanding approvals", kind: "operational", value: pendingApprovals, unit: "count", definition: "PENDING mission approval gates.", source: "MissionApproval", window: "now", sample: pendingApprovals },
    { key: "open_ops_findings", label: "Open operational findings", kind: "operational", value: openFindings, unit: "count", definition: "Operations findings in OPEN, ACKNOWLEDGED or INVESTIGATING.", source: "OpsFinding", window: "now", sample: openFindings },
    { key: "agents", label: "Agents", kind: "operational", value: agents, unit: "count", definition: "Agents provisioned in this workspace.", source: "Agent", window: "now", sample: agents },
  ];
}
