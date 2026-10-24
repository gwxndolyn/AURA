import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { emitEvent, audit } from "@/lib/events/emit";

/**
 * Autonomous task prioritization. Deterministic, explainable scoring:
 *
 *   Priority = 2·BusinessImpact + 2·Urgency + 3·SecurityRisk
 *              + DependencyCriticality − 0.5·EngineeringEffort
 *
 * DependencyCriticality = how many other tasks depend on this one (unblocking
 * work is valuable). Security is weighted highest. Each task gets a stored
 * score + a human-readable reason.
 */

const PRIORITY_BASELINE: Record<string, number> = { LOW: 1, MEDIUM: 3, HIGH: 4, CRITICAL: 5 };

export interface ScoredTask {
  id: string;
  title: string;
  score: number;
  reason: string;
}

/** Pure, deterministic scoring formula — unit-testable without the DB. */
export function scoreTask(input: {
  businessImpact: number;
  urgency: number;
  securityRisk: number;
  dependents: number;
  effort: number;
}): { score: number; reason: string } {
  const { businessImpact: impact, urgency, securityRisk: security, dependents: depCrit, effort } = input;
  const score = 2 * impact + 2 * urgency + 3 * security + depCrit - 0.5 * effort;
  const reason =
    `impact ${impact}×2 + urgency ${urgency}×2 + security ${security}×3 ` +
    `+ ${depCrit} dependents − effort ${effort}×0.5 = ${score.toFixed(1)}`;
  return { score, reason };
}

export async function prioritizeBacklog(companyId: string): Promise<ScoredTask[]> {
  const tasks = await prisma.task.findMany({
    where: { companyId, status: { in: ["BACKLOG", "PLANNED"] } },
  });

  // Count dependents: how many tasks list each task in their dependsOn.
  const dependentCount = new Map<string, number>();
  for (const t of tasks) {
    for (const dep of parseJSON<string[]>(t.dependsOn, [])) {
      dependentCount.set(dep, (dependentCount.get(dep) ?? 0) + 1);
    }
  }

  const scored: ScoredTask[] = [];
  for (const t of tasks) {
    const impact = t.businessImpact || PRIORITY_BASELINE[t.priority] || 3;
    const urgency = t.urgency || PRIORITY_BASELINE[t.priority] || 3;
    const security = t.securityRisk || (t.priority === "CRITICAL" ? 4 : 1);
    const depCrit = dependentCount.get(t.id) ?? 0;
    const effort = t.estimate || 3;

    const { score, reason } = scoreTask({ businessImpact: impact, urgency, securityRisk: security, dependents: depCrit, effort });

    await prisma.task.update({
      where: { id: t.id },
      data: { priorityScore: score, priorityReason: reason },
    });
    scored.push({ id: t.id, title: t.title, score, reason });
  }

  scored.sort((a, b) => b.score - a.score);

  await audit(companyId, "product-manager", "PRIORITIZE", "backlog", `${scored.length} tasks scored`);
  await emitEvent({
    companyId,
    type: "TASK_UPDATED",
    actor: "product-manager",
    message: `Prioritized ${scored.length} backlog tasks by impact, urgency, security & dependencies`,
  });

  return scored;
}
