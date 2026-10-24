/**
 * Company departments, mapped onto EXISTING agent roles (no new agents).
 * Live department state is derived from real rows every time it is read.
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";

export const DEPARTMENTS = {
  product: { label: "Product & planning", agents: ["ceo", "product-manager", "designer", "architect", "data-analyst", "support"] },
  engineering: { label: "Engineering", agents: ["frontend-engineer", "backend-engineer"] },
  qa: { label: "QA & verification", agents: ["qa-engineer", "reviewer"] },
  infra: { label: "Infrastructure & reliability", agents: ["devops"] },
  security: { label: "Security operations", agents: ["security-engineer", "red-team", "blue-team"] },
} as const;
export type DeptKey = keyof typeof DEPARTMENTS;
export const DEPT_KEYS = Object.keys(DEPARTMENTS) as DeptKey[];

export function deptOf(agentKey: string): DeptKey | null {
  for (const k of DEPT_KEYS) if ((DEPARTMENTS[k].agents as readonly string[]).includes(agentKey)) return k;
  return null;
}

const ACTIVE_MISSION = ["READY", "RUNNING", "PAUSED", "AWAITING_APPROVAL"];

/**
 * Operational (real) state per department, straight from persisted rows.
 * Sample missions (source SEEDED) are excluded from operational figures.
 */
export async function liveDepartments(companyId: string) {
  const since = new Date(Date.now() - 7 * 864e5);
  const [agents, tasks, runs, findings, opsFindings, incidents, secFindings, deployments, checks, approvals] = await Promise.all([
    prisma.agent.findMany({ where: { companyId }, select: { key: true, name: true, role: true, status: true, available: true, currentTask: true } }),
    prisma.missionTask.findMany({ where: { companyId, mission: { source: { not: "SEEDED" }, status: { in: ACTIVE_MISSION } }, status: { in: ["PENDING", "READY", "RUNNING", "WAITING_APPROVAL"] } }, select: { id: true, key: true, title: true, agentKey: true, status: true, missionId: true, mission: { select: { title: true } } }, take: 200 }),
    prisma.missionTaskRun.findMany({ where: { companyId, startedAt: { gte: since }, mission: { source: { not: "SEEDED" } } }, orderBy: { startedAt: "desc" }, take: 300, select: { id: true, missionId: true, taskKey: true, agentKey: true, status: true, outcome: true, errorCategory: true, startedAt: true } }),
    prisma.missionFinding.findMany({ where: { companyId, status: { in: ["OPEN", "UNRESOLVED"] }, supported: true, mission: { source: { not: "SEEDED" } } }, select: { id: true, code: true, title: true, severity: true, source: true, missionId: true } }),
    prisma.opsFinding.findMany({ where: { companyId, status: { in: ["OPEN", "ACKNOWLEDGED", "INVESTIGATING"] } }, select: { id: true, title: true, severity: true, category: true, ruleId: true } }),
    prisma.incident.findMany({ where: { companyId, status: { not: "RESOLVED" } }, select: { id: true, number: true, title: true, severity: true, status: true } }),
    prisma.securityFinding.findMany({ where: { companyId, status: { in: ["OPEN", "PATCHING"] } }, select: { id: true, code: true, title: true, severity: true, status: true } }),
    prisma.deployment.findMany({ where: { companyId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, env: true, version: true, status: true, createdAt: true } }),
    prisma.execRun.findMany({ where: { companyId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, check: true, status: true, passed: true, total: true, createdAt: true } }),
    prisma.missionApproval.count({ where: { companyId, status: "PENDING", mission: { source: { not: "SEEDED" } } } }),
  ]);

  const byDept = Object.fromEntries(DEPT_KEYS.map((k) => [k, { key: k, label: DEPARTMENTS[k].label, agents: [] as typeof agents, activeTasks: [] as typeof tasks, recentRuns: [] as typeof runs }])) as Record<DeptKey, { key: DeptKey; label: string; agents: typeof agents; activeTasks: typeof tasks; recentRuns: typeof runs }>;
  for (const a of agents) {
    const d = deptOf(a.key);
    if (d) byDept[d].agents.push(a);
  }
  for (const t of tasks) {
    const d = deptOf(t.agentKey);
    if (d) byDept[d].activeTasks.push(t);
  }
  for (const r of runs) {
    const d = deptOf(r.agentKey);
    if (d) byDept[d].recentRuns.push(r);
  }

  const qaRuns = runs.filter((r) => ["qa-engineer", "reviewer"].includes(r.agentKey));
  return {
    departments: DEPT_KEYS.map((k) => {
      const d = byDept[k];
      const busy = d.agents.filter((a) => ["THINKING", "WORKING"].includes(a.status)).length;
      const blocked = d.activeTasks.filter((t) => t.status === "WAITING_APPROVAL").length;
      const failed = d.recentRuns.filter((r) => r.status === "FAILED").length;
      return {
        key: k,
        label: d.label,
        agents: d.agents.map((a) => ({ key: a.key, name: a.name, role: a.role, status: a.status, available: a.available, currentTask: a.currentTask })),
        activeTasks: d.activeTasks.slice(0, 20).map((t) => ({ id: t.id, key: t.key, title: t.title, agentKey: t.agentKey, status: t.status, missionId: t.missionId, missionTitle: t.mission.title })),
        recentRuns: d.recentRuns.slice(0, 15),
        signals: { agents: d.agents.length, busy, queued: d.activeTasks.filter((t) => ["PENDING", "READY"].includes(t.status)).length, running: d.activeTasks.filter((t) => t.status === "RUNNING").length, blocked, recentFailures: failed },
      };
    }),
    qa: {
      verificationRuns: qaRuns.length,
      passed: qaRuns.filter((r) => ["passed", "approved"].includes(r.outcome)).length,
      failed: qaRuns.filter((r) => r.status === "FAILED" || ["tests_failed", "changes_requested"].includes(r.outcome)).length,
      checks,
    },
    security: { missionFindings: findings.filter((f) => f.source === "security" || f.source === "reviewer"), cyberRangeIncidents: incidents, cyberRangeFindings: secFindings, opsFindings: opsFindings.filter((f) => f.category === "engineering" || f.ruleId.startsWith("engineering.")) },
    infra: { deployments, simulatedPipeline: true },
    pendingApprovals: approvals,
    openOpsFindings: opsFindings.length,
  };
}

/** Parse helpers shared by API/UI. */
export const parseList = (s: string | null | undefined) => parseJSON<string[]>(s, []);
