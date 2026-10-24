import { prisma } from "@/lib/db";
import { usageSummary, BUDGET } from "@/lib/ai/budget";

/**
 * Computes the "Needs Attention" items for the Command Center from REAL state:
 * pending approvals, open security findings, budget pressure, failed deploys,
 * active incidents, blocked tasks, completed sprints. Each item is actionable
 * (carries a link + optional action the UI can trigger).
 */
export interface AttentionItem {
  id: string;
  level: "danger" | "warning" | "info" | "success";
  title: string;
  detail: string;
  href?: string; // relative to /app/:id
  action?: { label: string; method: "POST"; path: string; body?: Record<string, unknown> };
}

export async function computeAttention(companyId: string): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];

  const [pendingDeploys, criticalFindings, highFindings, activeIncidents, blockedTasks, activeSprint, usage] =
    await Promise.all([
      prisma.deployment.findMany({ where: { companyId, status: "PENDING_APPROVAL" }, orderBy: { createdAt: "desc" } }),
      prisma.securityFinding.count({ where: { companyId, severity: "CRITICAL", status: { in: ["OPEN", "PATCHING"] } } }),
      prisma.securityFinding.count({ where: { companyId, severity: "HIGH", status: { in: ["OPEN", "PATCHING"] } } }),
      prisma.incident.findMany({ where: { companyId, status: "ACTIVE" }, orderBy: { detectedAt: "desc" } }),
      prisma.task.count({ where: { companyId, status: "BLOCKED" } }),
      prisma.sprint.findFirst({ where: { companyId, status: "ACTIVE" } }),
      usageSummary(companyId),
    ]);

  // Mission gates and plans waiting on a human (sample missions are read-only, so excluded).
  const [gates, plans] = await Promise.all([
    prisma.missionApproval.findMany({ where: { companyId, status: "PENDING", mission: { source: { not: "SEEDED" } } }, include: { mission: { select: { id: true, title: true } } }, take: 5 }),
    prisma.mission.findMany({ where: { companyId, status: "AWAITING_APPROVAL", source: { not: "SEEDED" } }, select: { id: true, title: true }, take: 5 }),
  ]);
  for (const g of gates) {
    items.push({ id: `mission-gate-${g.id}`, level: "warning", title: "Mission change waiting for your approval", detail: `${g.mission.title}: ${g.action}`, href: `/missions/${g.mission.id}` });
  }
  for (const p of plans) {
    items.push({ id: `mission-plan-${p.id}`, level: "info", title: "Mission plan ready for review", detail: `${p.title}. Nothing runs until you approve the plan.`, href: `/missions/${p.id}` });
  }

  for (const d of pendingDeploys) {
    items.push({
      id: `deploy-${d.id}`,
      level: "warning",
      title: "Production deployment requires approval",
      detail: `${d.version} → ${d.env}. Review changes before shipping.`,
      href: "/deployments",
      action: { label: "Approve", method: "POST", path: `/api/companies/${companyId}/deploy/${d.id}/approve`, body: { decision: "approve" } },
    });
  }

  for (const inc of activeIncidents) {
    items.push({
      id: `incident-${inc.id}`,
      level: "danger",
      title: `Active security incident #${inc.number}`,
      detail: `${inc.title} — ${inc.severity}. Responders engaged.`,
      href: "/incidents",
    });
  }

  if (criticalFindings > 0) {
    items.push({
      id: "findings-critical",
      level: "danger",
      title: `${criticalFindings} critical vulnerability${criticalFindings > 1 ? "ies" : ""} open`,
      detail: "Patch immediately to protect customer data.",
      href: "/incidents",
    });
  }
  if (highFindings > 0) {
    items.push({
      id: "findings-high",
      level: "warning",
      title: `${highFindings} high-severity finding${highFindings > 1 ? "s" : ""} open`,
      detail: "Schedule remediation this sprint.",
      href: "/incidents",
    });
  }

  const pct = BUDGET.dailyUsd > 0 ? usage.todayCost / BUDGET.dailyUsd : 0;
  if (pct >= 1) {
    items.push({ id: "budget", level: "danger", title: "AI budget exceeded (hard stop)", detail: `$${usage.todayCost.toFixed(2)} / $${BUDGET.dailyUsd} today. Agents paused.`, href: "/settings" });
  } else if (pct >= 0.8) {
    items.push({ id: "budget", level: "warning", title: `AI budget at ${Math.round(pct * 100)}%`, detail: `$${usage.todayCost.toFixed(2)} / $${BUDGET.dailyUsd} today.`, href: "/settings" });
  }

  if (blockedTasks > 0) {
    items.push({ id: "blocked", level: "warning", title: `${blockedTasks} task${blockedTasks > 1 ? "s" : ""} blocked`, detail: "Reassign or unblock to keep the sprint moving.", href: "/projects" });
  }

  if (activeSprint) {
    const [done, total] = await Promise.all([
      prisma.task.count({ where: { companyId, sprintId: activeSprint.id, status: "DONE" } }),
      prisma.task.count({ where: { companyId, sprintId: activeSprint.id } }),
    ]);
    if (total > 0 && done === total) {
      items.push({ id: `sprint-${activeSprint.id}`, level: "success", title: `${activeSprint.name} completed`, detail: `All ${total} tasks done. Plan the next sprint.`, href: "/projects", action: { label: "Plan next sprint", method: "POST", path: `/api/companies/${companyId}/sprint` } });
    }
  }

  // Stable ordering: danger → warning → info → success.
  const rank = { danger: 0, warning: 1, info: 2, success: 3 };
  items.sort((a, b) => rank[a.level] - rank[b.level]);
  return items;
}
