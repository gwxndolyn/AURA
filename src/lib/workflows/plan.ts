import { prisma } from "@/lib/db";
import { runAgent } from "@/lib/agents/orchestrator";
import { emitEvent, audit } from "@/lib/events/emit";
import { parseJSON } from "@/lib/utils";
import type { Priority } from "@/lib/types";

interface PlanTask {
  title: string;
  description: string;
  priority: Priority;
  assignee: string;
  estimate: number;
  acceptance: string[];
}

/**
 * Autonomous planning: the PM agent turns a goal into a strategy + task list.
 * Tasks are persisted and assigned to agents. Returns created task ids.
 */
export async function planGoal(companyId: string, goal: string) {
  const run = await runAgent({
    companyId,
    agentKey: "product-manager",
    objective: `Plan: ${goal}`,
    kind: "plan",
    context: `Decompose this goal into a prioritized, assignable task list with acceptance criteria.`,
  });

  const parsed = parseJSON<{ strategy: string; tasks: PlanTask[] }>(run.text, {
    strategy: "",
    tasks: [],
  });

  const project = await prisma.project.create({
    data: {
      companyId,
      name: goal.length > 50 ? goal.slice(0, 50) + "..." : goal,
      description: parsed.strategy || `Initiative: ${goal}`,
      status: "ACTIVE",
    },
  });

  const sprint = await prisma.sprint.findFirst({
    where: { companyId, status: "ACTIVE" },
    orderBy: { startDay: "desc" },
  });

  const agents = await prisma.agent.findMany({ where: { companyId } });
  const agentByKey = new Map(agents.map((a) => [a.key, a]));

  const created: string[] = [];
  for (const t of parsed.tasks) {
    const assignee = agentByKey.get(t.assignee) ?? agentByKey.get("backend-engineer");
    const task = await prisma.task.create({
      data: {
        companyId,
        projectId: project.id,
        sprintId: sprint?.id,
        assigneeId: assignee?.id,
        title: t.title,
        description: t.description,
        priority: t.priority,
        estimate: t.estimate ?? 3,
        status: "PLANNED",
        acceptance: JSON.stringify((t.acceptance ?? []).map((text) => ({ text, met: false }))),
      },
    });
    created.push(task.id);
    await emitEvent({
      companyId,
      type: "TASK_CREATED",
      actor: "product-manager",
      message: `Created task: ${t.title} → ${assignee?.name ?? "unassigned"}`,
      meta: { taskId: task.id },
    });
  }

  await audit(companyId, "product-manager", "PLAN_GOAL", project.id, `${created.length} tasks created`);

  return { projectId: project.id, strategy: parsed.strategy, taskIds: created };
}
