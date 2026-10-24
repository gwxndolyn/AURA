import { prisma } from "@/lib/db";
import { planGoal } from "./plan";
import { executeTask } from "./executeTask";
import { runDeployment } from "./deploy";
import { runAgent } from "@/lib/agents/orchestrator";
import { emitEvent } from "@/lib/events/emit";

/**
 * High-level "build" workflow. Plans the goal into tasks, has the architect
 * weigh in, executes each task through the quality gate, then deploys.
 * This is what the "BUILD SOMETHING" / "Build MVP" action triggers.
 */
export async function buildGoal(companyId: string, goal: string) {
  await prisma.company.update({ where: { id: companyId }, data: { status: "BUILDING" } });
  await emitEvent({
    companyId,
    type: "AGENT_STARTED",
    actor: "ceo",
    message: `CEO kicked off initiative: ${goal}`,
  });

  // Architect provides a design pass that informs the team.
  await runAgent({
    companyId,
    agentKey: "architect",
    objective: `Design approach for: ${goal}`,
    kind: "architecture",
  });

  const plan = await planGoal(companyId, goal);

  const results = [];
  for (const taskId of plan.taskIds) {
    try {
      const r = await executeTask(companyId, taskId);
      results.push(r);
    } catch (err) {
      await emitEvent({
        companyId,
        type: "AGENT_FAILED",
        actor: "system",
        level: "danger",
        message: `Task ${taskId} failed: ${(err as Error).message}`,
      });
    }
  }

  const deploy = await runDeployment(companyId, "staging");

  await prisma.company.update({
    where: { id: companyId },
    data: { status: "OPERATING", velocity: { increment: 5 } },
  });

  await emitEvent({
    companyId,
    type: "COMPANY_UPDATED",
    actor: "ceo",
    level: "success",
    message: `Initiative complete: ${results.filter((r) => r.status === "DONE").length}/${results.length} tasks done, deploy ${deploy.success ? "succeeded" : "failed"}`,
  });

  return { plan, results, deploy };
}
