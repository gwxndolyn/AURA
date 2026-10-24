/**
 * Load the persisted state the health rules evaluate. Every query is scoped
 * by companyId. Windows are bounded so evaluation cost stays constant as
 * history grows.
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { capabilityFor } from "@/lib/agents/capabilities";
import { dockerAvailable } from "@/lib/sandbox/runner";
import { aiMode } from "@/lib/ai/claude";
import type { OpsSnapshot } from "./rules";

const RUN_WINDOW = 400;
const TOOL_WINDOW = 400;
const EVAL_WINDOW = 200;

export interface SnapshotOptions {
  now?: Date;
  /** Skip live probes (tests / fixtures supply integration state). */
  probe?: boolean;
}

export async function loadSnapshot(companyId: string, opts: SnapshotOptions = {}): Promise<OpsSnapshot> {
  const now = opts.now ?? new Date();
  const [missions, tasks, runs, approvals, deployments, evaluations, findings] = await Promise.all([
    prisma.mission.findMany({ where: { companyId }, select: { id: true, title: true, status: true, source: true, costUsd: true, budgetUsd: true, repairRounds: true, maxRepairs: true, statusReason: true, createdAt: true, startedAt: true, completedAt: true } }),
    prisma.missionTask.findMany({ where: { companyId, status: { in: ["RUNNING", "READY", "PENDING", "WAITING_APPROVAL", "FAILED", "SUCCEEDED", "SKIPPED"] } }, select: { id: true, missionId: true, key: true, title: true, kind: true, agentKey: true, status: true, errorCategory: true, startedAt: true, leaseExpiresAt: true, planVersion: true } }),
    prisma.missionTaskRun.findMany({ where: { companyId }, orderBy: { startedAt: "desc" }, take: RUN_WINDOW, select: { id: true, missionId: true, taskKey: true, taskId: true, agentKey: true, status: true, outcome: true, errorCategory: true, outputValid: true, costUsd: true, startedAt: true, agentRunIds: true } }),
    prisma.missionApproval.findMany({ where: { companyId, status: "PENDING" }, select: { id: true, missionId: true, status: true, createdAt: true, action: true } }),
    prisma.deployment.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, env: true, version: true, status: true, stages: true, createdAt: true } }),
    prisma.evaluation.findMany({ where: { companyId }, orderBy: { startedAt: "desc" }, take: EVAL_WINDOW, select: { id: true, agentKey: true, datasetId: true, mode: true, label: true, status: true, total: true, passRate: true, promptKey: true, promptVersion: true, model: true, startedAt: true } }),
    prisma.missionFinding.findMany({ where: { companyId, blocking: true, supported: true, status: { in: ["OPEN", "UNRESOLVED"] } }, select: { id: true, missionId: true, code: true, title: true, severity: true, status: true } }),
  ]);

  // Latest evidence of activity per mission (mission row, last run, last approval).
  const lastRun = new Map<string, Date>();
  for (const r of runs) if (!lastRun.has(r.missionId)) lastRun.set(r.missionId, r.startedAt);
  const kindOf = new Map(tasks.map((t) => [`${t.missionId}:${t.key}`, t.kind]));

  const agentRunIds = runs.flatMap((r) => parseJSON<string[]>(r.agentRunIds, []));
  const toolCalls = agentRunIds.length
    ? await prisma.toolCall.findMany({ where: { runId: { in: agentRunIds.slice(0, 2000) }, run: { companyId } }, orderBy: { createdAt: "desc" }, take: TOOL_WINDOW, select: { id: true, tool: true, status: true, createdAt: true } })
    : [];

  const probe = opts.probe ?? true;
  const docker = probe ? await dockerAvailable() : null;

  return {
    now,
    missions: missions.map((m) => ({
      id: m.id,
      title: m.title,
      status: m.status,
      source: m.source,
      costUsd: m.costUsd,
      budgetUsd: m.budgetUsd,
      repairRounds: m.repairRounds,
      maxRepairs: m.maxRepairs,
      statusReason: m.statusReason,
      updatedAt: [m.createdAt, m.startedAt, m.completedAt, lastRun.get(m.id)].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0],
    })),
    tasks: tasks.map((t) => ({ id: t.id, missionId: t.missionId, key: t.key, title: t.title, kind: t.kind, agentKey: t.agentKey, status: t.status, errorCategory: t.errorCategory, startedAt: t.startedAt, leaseExpiresAt: t.leaseExpiresAt, maxDurationMs: capabilityFor(t.agentKey)?.maxDurationMs ?? null })),
    runs: runs.map((r) => ({ id: r.id, missionId: r.missionId, taskKey: r.taskKey, taskKind: kindOf.get(`${r.missionId}:${r.taskKey}`) ?? "", agentKey: r.agentKey, status: r.status, outcome: r.outcome, errorCategory: r.errorCategory, outputValid: r.outputValid, costUsd: r.costUsd, startedAt: r.startedAt })),
    approvals,
    toolCalls,
    deployments: deployments.map((d) => ({ id: d.id, env: d.env, version: d.version, status: d.status, failedStage: parseJSON<{ name: string; status: string }[]>(d.stages, []).find((x) => x.status === "FAILED")?.name ?? null, createdAt: d.createdAt })),
    evaluations,
    integrations: [
      { id: "sandbox", label: "Docker sandbox", available: docker, detail: docker === null ? "not probed" : docker ? "docker reachable" : "Docker daemon not reachable" },
      { id: "model", label: "Model provider", available: probe ? true : null, detail: aiMode() === "live" ? "Anthropic API configured" : "simulation mode (no API key) — agent text is simulated" },
    ],
    blockingReviewFindings: findings,
  };
}
