/**
 * Company timeline: real persisted events and simulation events, each
 * labelled with its provenance. Operational entries come from existing
 * tables; simulation entries come from TwinRun transitions and config
 * history (marked `simulated: true`).
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { deptOf, type DeptKey } from "./departments";
import type { Transition } from "./engine";

export interface TimelineItem {
  id: string;
  at: string; // real timestamp (operational) or run timestamp (simulation)
  simDay?: number; // simulated day within a run
  provenance: "operational" | "simulation";
  dept: DeptKey | "company" | null;
  type: string;
  text: string;
  ref?: { kind: "mission" | "run" | "finding" | "config" | "approval"; id: string };
  runId?: string;
}

const TRANSITION_DEPT: Partial<Record<Transition["type"], DeptKey | "company">> = { verify_pass: "qa", verify_fail: "qa", incident_start: "infra", incident_mitigated: "infra", rollback: "infra", approval_wait: "security", budget_exhausted: "company", deadline_missed: "company" };

export async function companyTimeline(companyId: string, f: { dept?: string; provenance?: string; runId?: string; missionId?: string; type?: string; hours?: number } = {}) {
  const since = new Date(Date.now() - (f.hours && f.hours > 0 ? f.hours : 24 * 30) * 3600_000);
  const out: TimelineItem[] = [];

  if (f.provenance !== "simulation" && !f.runId) {
    const [missions, runs, findings, approvals] = await Promise.all([
      prisma.mission.findMany({ where: { companyId, source: { not: "SEEDED" }, createdAt: { gte: since }, ...(f.missionId ? { id: f.missionId } : {}) }, select: { id: true, title: true, status: true, createdAt: true, completedAt: true } }),
      prisma.missionTaskRun.findMany({ where: { companyId, startedAt: { gte: since }, mission: { source: { not: "SEEDED" } }, ...(f.missionId ? { missionId: f.missionId } : {}) }, orderBy: { startedAt: "desc" }, take: 150, select: { id: true, missionId: true, taskKey: true, agentKey: true, status: true, outcome: true, errorCategory: true, startedAt: true, completedAt: true } }),
      prisma.missionFinding.findMany({ where: { companyId, createdAt: { gte: since }, supported: true, mission: { source: { not: "SEEDED" } }, ...(f.missionId ? { missionId: f.missionId } : {}) }, select: { id: true, missionId: true, code: true, title: true, source: true, createdAt: true } }),
      prisma.missionApproval.findMany({ where: { companyId, createdAt: { gte: since }, mission: { source: { not: "SEEDED" } }, ...(f.missionId ? { missionId: f.missionId } : {}) }, select: { id: true, missionId: true, action: true, status: true, createdAt: true, decidedAt: true, decidedBy: true } }),
    ]);
    for (const m of missions) {
      out.push({ id: `m-${m.id}`, at: m.createdAt.toISOString(), provenance: "operational", dept: "product", type: "mission_created", text: `Mission created: ${m.title}`, ref: { kind: "mission", id: m.id } });
      if (m.completedAt) out.push({ id: `mc-${m.id}`, at: m.completedAt.toISOString(), provenance: "operational", dept: "company", type: `mission_${m.status.toLowerCase()}`, text: `Mission ${m.status.toLowerCase()}: ${m.title}`, ref: { kind: "mission", id: m.id } });
    }
    for (const r of runs) out.push({ id: `r-${r.id}`, at: (r.completedAt ?? r.startedAt).toISOString(), provenance: "operational", dept: deptOf(r.agentKey), type: r.status === "FAILED" ? "task_failed" : r.outcome === "tests_failed" ? "qa_failure" : "task_run", text: `${r.agentKey} ${r.taskKey}: ${r.outcome || r.status.toLowerCase()}${r.errorCategory ? ` (${r.errorCategory})` : ""}`, ref: { kind: "mission", id: r.missionId } });
    for (const x of findings) out.push({ id: `f-${x.id}`, at: x.createdAt.toISOString(), provenance: "operational", dept: x.source === "security" ? "security" : "qa", type: "finding", text: `${x.code} ${x.title}`, ref: { kind: "mission", id: x.missionId } });
    for (const a of approvals) {
      out.push({ id: `a-${a.id}`, at: a.createdAt.toISOString(), provenance: "operational", dept: "infra", type: "approval_requested", text: `Approval requested: ${a.action}`, ref: { kind: "mission", id: a.missionId } });
      if (a.decidedAt) out.push({ id: `ad-${a.id}`, at: a.decidedAt.toISOString(), provenance: "operational", dept: "infra", type: `approval_${a.status.toLowerCase()}`, text: `Approval ${a.status.toLowerCase()} by ${a.decidedBy}`, ref: { kind: "mission", id: a.missionId } });
    }
  }

  if (f.provenance !== "operational" && !f.missionId) {
    const cfg = await prisma.twinConfig.findUnique({ where: { companyId } });
    if (!f.runId) for (const h of parseJSON<{ version: number; at: string; by: string; change: string }[]>(cfg?.history, [])) out.push({ id: `cfg-${h.version}`, at: h.at, provenance: "simulation", dept: "company", type: "ceo_decision", text: `CEO decision v${h.version} by ${h.by}: ${h.change}`, ref: { kind: "config", id: `v${h.version}` } });
    const runs = await prisma.twinRun.findMany({ where: { companyId, createdAt: { gte: since }, ...(f.runId ? { id: f.runId } : {}) }, orderBy: { createdAt: "desc" }, take: f.runId ? 1 : 10 });
    for (const r of runs) {
      out.push({ id: `run-${r.id}`, at: r.createdAt.toISOString(), provenance: "simulation", dept: "company", type: "simulation_run", text: `${r.label} (${r.scenario}, seed ${r.seed}, ${r.rulesVersion})`, ref: { kind: "run", id: r.id }, runId: r.id });
      for (const [i, t] of parseJSON<Transition[]>(r.transitions, []).entries()) {
        if (t.type === "progress") continue;
        out.push({ id: `run-${r.id}-${i}`, at: r.createdAt.toISOString(), simDay: t.t, provenance: "simulation", dept: (TRANSITION_DEPT[t.type] ?? (t.dept === "qa" ? "qa" : t.dept === "security" ? "security" : t.dept === "infra" ? "infra" : "engineering")) as DeptKey | "company", type: t.type, text: t.item ? `${t.item}: ${t.detail}` : t.detail, runId: r.id });
      }
    }
  }

  let items = out;
  if (f.dept) items = items.filter((x) => x.dept === f.dept);
  if (f.type) items = items.filter((x) => x.type === f.type);
  // Real events by time; simulation transitions by run then simulated day.
  return items.sort((a, b) => b.at.localeCompare(a.at) || (a.runId && b.runId && a.runId === b.runId ? (a.simDay ?? 0) - (b.simDay ?? 0) : 0)).slice(0, 400);
}
