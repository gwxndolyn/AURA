/**
 * Live office snapshot: reads persisted rows for one workspace and returns the
 * inputs the pure mapper (state.ts) needs, plus the evidence the inspector
 * links to. Read-only. Every query is scoped by companyId; sample (SEEDED)
 * missions are excluded so the office never shows replayed history as live.
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { TERMINAL_MISSION } from "@/lib/missions/state";
import type { OfficeAgentInput, OfficeInteraction, OfficeTaskInput, OfficeWorkInput } from "./state";

const OPEN_MISSION = ["DRAFT", "PLANNING", "AWAITING_APPROVAL", "READY", "RUNNING", "PAUSED"].filter((s) => !TERMINAL_MISSION.includes(s as never));

export async function officeSnapshot(companyId: string, now = new Date()) {
  const since = new Date(now.getTime() - 24 * 3600_000);
  const recentTask = new Date(now.getTime() - 30 * 60_000);
  const [agents, tasks, handoffs, findings, approvals, execRuns, items, artifacts, runs] = await Promise.all([
    prisma.agent.findMany({ where: { companyId }, select: { key: true, name: true, role: true, status: true, available: true }, orderBy: { key: "asc" } }),
    prisma.missionTask.findMany({
      where: {
        companyId,
        mission: { source: { not: "SEEDED" } },
        OR: [{ status: { in: ["PENDING", "READY", "RUNNING", "WAITING_APPROVAL", "FAILED"] }, mission: { status: { in: OPEN_MISSION } } }, { status: "SUCCEEDED", completedAt: { gte: recentTask } }],
      },
      select: { id: true, key: true, title: true, kind: true, agentKey: true, status: true, verification: true, missionId: true, startedAt: true, completedAt: true, leaseExpiresAt: true, output: true, mission: { select: { title: true, status: true } } },
      orderBy: { createdAt: "desc" },
      take: 300,
    }),
    prisma.missionHandoff.findMany({ where: { companyId, createdAt: { gte: since }, valid: true, mission: { source: { not: "SEEDED" } } }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, missionId: true, fromAgent: true, toAgents: true, fromTaskKey: true, createdAt: true } }),
    prisma.missionFinding.findMany({ where: { companyId, createdAt: { gte: since }, supported: true, mission: { source: { not: "SEEDED" } } }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, missionId: true, code: true, title: true, source: true, blocking: true, status: true, taskKey: true, createdAt: true, mission: { select: { tasks: { select: { key: true, agentKey: true, kind: true } } } } } }),
    prisma.missionApproval.findMany({ where: { companyId, status: "PENDING", mission: { source: { not: "SEEDED" } } }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, missionId: true, taskKey: true, action: true, createdAt: true } }),
    prisma.execRun.findMany({ where: { companyId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, check: true, status: true, mode: true, passed: true, failed: true, total: true, requestedBy: true, createdAt: true } }),
    prisma.backlogItem.findMany({ where: { companyId, status: { in: ["IN_PROGRESS", "BLOCKED"] }, product: { status: "ACTIVE" } }, take: 100, select: { id: true, key: true, title: true, kind: true, status: true, blockedReason: true, missionId: true, productId: true, capabilities: true, product: { select: { title: true } } } }),
    prisma.productArtifact.findMany({ where: { companyId, status: "PROPOSED", kind: { in: ["DESIGN", "ARCHITECTURE"] }, product: { status: "ACTIVE" } }, take: 20, orderBy: { createdAt: "desc" }, select: { id: true, kind: true, title: true, version: true, status: true, producedBy: true, productId: true, product: { select: { title: true } } } }),
    prisma.missionTaskRun.findMany({ where: { companyId, startedAt: { gte: since }, mission: { source: { not: "SEEDED" } } }, orderBy: { startedAt: "desc" }, take: 60, select: { id: true, missionId: true, taskKey: true, agentKey: true, status: true, outcome: true, errorCategory: true, startedAt: true } }),
  ]);

  const agentIn: OfficeAgentInput[] = agents;
  const taskIn: OfficeTaskInput[] = tasks.map((t) => ({
    id: t.id,
    key: t.key,
    title: t.title,
    kind: t.kind,
    agentKey: t.agentKey,
    status: t.status,
    verification: t.verification,
    missionId: t.missionId,
    missionTitle: t.mission.title,
    missionStatus: t.mission.status,
    startedAt: t.startedAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    leaseExpiresAt: t.leaseExpiresAt?.toISOString() ?? null,
    output: t.output.slice(0, 300),
  }));
  // BacklogItem has no single owner: the first agent in its capability list is shown as the owner.
  const workIn: OfficeWorkInput[] = [
    ...items.flatMap((i) => {
      const owner = parseJSON<string[]>(i.capabilities, [])[0];
      return owner ? [{ id: i.id, agentKey: owner, kind: "item" as const, title: `${i.key} ${i.title}`, status: i.status, itemKind: i.kind, productId: i.productId, productTitle: i.product.title, blockedReason: i.blockedReason, missionId: i.missionId }] : [];
    }),
    ...artifacts.map((a) => ({ id: a.id, agentKey: a.producedBy, kind: "artifact" as const, title: `${a.title} v${a.version}`, status: a.status, itemKind: a.kind, productId: a.productId, productTitle: a.product.title })),
  ];
  const interactions: OfficeInteraction[] = [
    ...handoffs.map((h) => ({ id: `h-${h.id}`, kind: "handoff" as const, from: h.fromAgent, to: parseJSON<string[]>(h.toAgents, []), text: `Handoff from ${h.fromTaskKey}`, at: h.createdAt.toISOString(), href: `/missions/${h.missionId}` })),
    ...findings.map((f) => {
      const raisedBy = f.mission.tasks.find((t) => t.key === f.taskKey)?.agentKey ?? f.source;
      const implementers = [...new Set(f.mission.tasks.filter((t) => t.kind === "CODE_CHANGE").map((t) => t.agentKey))];
      return { id: `f-${f.id}`, kind: "finding" as const, from: raisedBy, to: implementers, text: `${f.code}${f.blocking ? " (blocking)" : ""}: ${f.title}`, at: f.createdAt.toISOString(), href: `/missions/${f.missionId}` };
    }),
  ];
  return {
    now: now.toISOString(),
    agents: agentIn,
    tasks: taskIn,
    work: workIn,
    interactions,
    approvals: approvals.map((a) => ({ id: a.id, missionId: a.missionId, taskKey: a.taskKey, action: a.action, at: a.createdAt.toISOString() })),
    execRuns: execRuns.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    runs: runs.map((r) => ({ ...r, startedAt: r.startedAt.toISOString() })),
  };
}

export type OfficeSnapshot = Awaited<ReturnType<typeof officeSnapshot>>;
