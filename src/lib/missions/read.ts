/**
 * Read models for the Mission Control UI. Every query is scoped by companyId
 * (callers pass the id that requireWorkspaceAccess already authorized).
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { levels } from "./graph";
import { MISSION_STATUS_HELP, type MissionStatus } from "./state";

export async function listMissions(companyId: string) {
  const rows = await prisma.mission.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { tasks: { select: { status: true, planVersion: true } }, approvals: { where: { status: "PENDING" }, select: { id: true } } },
  });
  return rows.map(({ tasks, approvals, ...m }) => {
    const current = tasks.filter((t) => t.planVersion === m.planVersion);
    return {
      ...m,
      acceptance: parseJSON<string[]>(m.acceptance, []),
      statusHelp: MISSION_STATUS_HELP[m.status as MissionStatus] ?? "",
      progress: { done: current.filter((t) => t.status === "SUCCEEDED").length, total: current.length, failed: current.filter((t) => t.status === "FAILED").length },
      pendingApprovals: approvals.length,
    };
  });
}

export async function missionDetail(missionId: string, companyId: string) {
  const m = await prisma.mission.findFirst({
    where: { id: missionId, companyId },
    include: {
      plans: { orderBy: { version: "desc" } },
      tasks: { orderBy: { createdAt: "asc" } },
      artifacts: { orderBy: { createdAt: "asc" } },
      approvals: { orderBy: { createdAt: "desc" } },
      findings: { orderBy: { createdAt: "asc" }, select: { code: true, source: true, severity: true, blocking: true, title: true, status: true, supported: true } },
    },
  });
  if (!m) return null;
  const tasks = m.tasks
    .filter((t) => t.planVersion === m.planVersion)
    .map((t) => ({
      ...t,
      tools: parseJSON<string[]>(t.tools, []),
      files: parseJSON<string[]>(t.files, []),
      dependsOn: parseJSON<string[]>(t.dependsOn, []),
      acceptance: parseJSON<string[]>(t.acceptance, []),
    }));
  return {
    ...m,
    acceptance: parseJSON<string[]>(m.acceptance, []),
    statusHelp: MISSION_STATUS_HELP[m.status as MissionStatus] ?? "",
    plans: m.plans.map((p) => ({ ...p, risks: parseJSON<string[]>(p.risks, []) })),
    tasks,
    levels: levels(tasks.map((t) => ({ key: t.key, dependsOn: t.dependsOn, status: t.status }))),
    artifacts: m.artifacts.map((a) => ({ ...a, meta: parseJSON<Record<string, unknown>>(a.meta, {}) })),
    // The payload hash is an integrity check, not something the client needs.
    approvals: m.approvals.map(({ payloadHash: _h, ...a }) => a),
  };
}
