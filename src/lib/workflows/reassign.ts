import { prisma } from "@/lib/db";
import { emitEvent, audit } from "@/lib/events/emit";
import { sendMessage } from "@/lib/agents/messaging";

/** Fallback peers by role when the primary assignee is unavailable. */
const FALLBACK: Record<string, string[]> = {
  "frontend-engineer": ["backend-engineer", "architect"],
  "backend-engineer": ["frontend-engineer", "architect"],
  "qa-engineer": ["backend-engineer"],
  devops: ["backend-engineer"],
  architect: ["backend-engineer"],
  "security-engineer": ["backend-engineer"],
};

/** Mark an agent unavailable (e.g. the agent-failure test). */
export async function setAgentAvailability(companyId: string, agentKey: string, available: boolean) {
  const agent = await prisma.agent.update({
    where: { companyId_key: { companyId, key: agentKey } },
    data: { available, status: available ? "IDLE" : "BLOCKED" },
  });
  await emitEvent({
    companyId,
    type: available ? "AGENT_COMPLETED" : "AGENT_FAILED",
    actor: agentKey,
    level: available ? "success" : "warning",
    message: available ? `${agent.name} is available again` : `${agent.name} is unavailable`,
  });
  return agent;
}

/**
 * Reassign all open tasks of an unavailable agent to an available peer.
 * Driven by the PM. Returns the number of tasks reassigned. No manual DB edits.
 */
export async function reassignFromUnavailable(companyId: string, agentKey: string) {
  const agent = await prisma.agent.findUnique({ where: { companyId_key: { companyId, key: agentKey } } });
  if (!agent) throw new Error("Agent not found");

  const openTasks = await prisma.task.findMany({
    where: { companyId, assigneeId: agent.id, status: { in: ["BACKLOG", "PLANNED", "IN_PROGRESS", "REVIEW"] } },
  });
  if (openTasks.length === 0) return { reassigned: 0, to: null };

  // Pick the first available fallback peer.
  const candidates = FALLBACK[agentKey] ?? ["backend-engineer"];
  let target = null as null | { id: string; key: string; name: string };
  for (const key of candidates) {
    const peer = await prisma.agent.findUnique({ where: { companyId_key: { companyId, key } } });
    if (peer && peer.available) {
      target = { id: peer.id, key: peer.key, name: peer.name };
      break;
    }
  }
  if (!target) return { reassigned: 0, to: null };

  await prisma.task.updateMany({
    where: { id: { in: openTasks.map((t) => t.id) } },
    data: { assigneeId: target.id },
  });

  await sendMessage({
    companyId,
    fromKey: "product-manager",
    toKey: target.key,
    type: "HANDOFF",
    severity: "MEDIUM",
    message: `${agent.name} is unavailable — reassigning ${openTasks.length} task(s) to you.`,
  });
  await emitEvent({
    companyId,
    type: "TASK_UPDATED",
    actor: "product-manager",
    level: "warning",
    message: `Reassigned ${openTasks.length} task(s) from ${agent.name} → ${target.name}`,
  });
  await audit(companyId, "product-manager", "REASSIGN", agent.id, `${openTasks.length} tasks → ${target.key}`);

  return { reassigned: openTasks.length, to: target.key };
}
