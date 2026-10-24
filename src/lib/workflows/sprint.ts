import { prisma } from "@/lib/db";
import { prioritizeBacklog } from "./prioritize";
import { emitEvent, audit } from "@/lib/events/emit";

/**
 * Autonomous sprint planning. The PM inspects the backlog, prioritizes it,
 * checks agent availability and dependencies, estimates effort against a
 * capacity budget, selects the top tasks that fit, assigns them, and creates
 * the sprint. Each decision is emitted so the user can watch it live.
 */
export async function planSprint(companyId: string, opts?: { capacity?: number }) {
  await emitEvent({ companyId, type: "AGENT_STARTED", actor: "product-manager", message: "Planning next sprint…" });

  // 1. Prioritize.
  const scored = await prioritizeBacklog(companyId);
  await emitEvent({ companyId, type: "TASK_UPDATED", actor: "product-manager", message: `Backlog scored: ${scored.length} candidate tasks` });

  // 2. Capacity from available engineers (each ~8 effort points/sprint).
  const engineers = await prisma.agent.findMany({
    where: { companyId, available: true, key: { in: ["frontend-engineer", "backend-engineer", "qa-engineer", "devops"] } },
  });
  const capacity = opts?.capacity ?? engineers.length * 8;
  await emitEvent({ companyId, type: "AGENT_THINKING", actor: "product-manager", persist: false, message: `Capacity: ${capacity} points across ${engineers.length} available engineers` });

  // 3. Select tasks that fit capacity, honoring dependency readiness.
  const tasks = await prisma.task.findMany({ where: { companyId, status: { in: ["BACKLOG", "PLANNED"] } } });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const doneIds = new Set((await prisma.task.findMany({ where: { companyId, status: "DONE" }, select: { id: true } })).map((t) => t.id));

  const ordered = scored.map((s) => byId.get(s.id)!).filter(Boolean);
  const selected: typeof tasks = [];
  let used = 0;
  for (const t of ordered) {
    const deps: string[] = JSON.parse(t.dependsOn || "[]");
    const depsReady = deps.every((d) => doneIds.has(d) || selected.some((s) => s.id === d));
    if (!depsReady) continue;
    if (used + t.estimate > capacity) continue;
    selected.push(t);
    used += t.estimate;
  }

  // 4. Create the sprint and assign tasks.
  const count = await prisma.sprint.count({ where: { companyId } });
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  const startDay = company?.simDay ?? 0;
  const sprint = await prisma.sprint.create({
    data: { companyId, name: `Sprint ${count + 1}`, status: "ACTIVE", startDay, endDay: startDay + 14 },
  });

  for (const t of selected) {
    await prisma.task.update({ where: { id: t.id }, data: { sprintId: sprint.id, status: "PLANNED" } });
  }

  await emitEvent({
    companyId,
    type: "TASK_UPDATED",
    actor: "product-manager",
    level: "success",
    message: `Created ${sprint.name}: ${selected.length} tasks, ${used}/${capacity} points committed`,
    meta: { sprintId: sprint.id },
  });
  await audit(companyId, "product-manager", "PLAN_SPRINT", sprint.id, `${selected.length} tasks, ${used} pts`);

  return {
    sprintId: sprint.id,
    capacity,
    committed: used,
    selected: selected.map((t) => ({ id: t.id, title: t.title, estimate: t.estimate })),
    deferred: ordered.length - selected.length,
  };
}
