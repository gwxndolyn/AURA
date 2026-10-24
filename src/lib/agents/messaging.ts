import { prisma } from "@/lib/db";
import { emitEvent } from "@/lib/events/emit";
import { getAgentDef } from "./definitions";

/**
 * Structured agent-to-agent messaging. Messages are persisted and surfaced in
 * the live feed + UI. Used for bug reports, handoffs, questions, decisions.
 */
export async function sendMessage(args: {
  companyId: string;
  fromKey: string;
  toKey: string;
  type: "BUG_REPORT" | "HANDOFF" | "QUESTION" | "DECISION" | "NOTIFY" | "FEATURE_REQUEST";
  message: string;
  severity?: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  taskId?: string;
}) {
  const [from, to] = await Promise.all([
    prisma.agent.findUnique({ where: { companyId_key: { companyId: args.companyId, key: args.fromKey } } }),
    prisma.agent.findUnique({ where: { companyId_key: { companyId: args.companyId, key: args.toKey } } }),
  ]);
  if (!from || !to) throw new Error("Unknown agent in message");

  const msg = await prisma.agentMessage.create({
    data: {
      companyId: args.companyId,
      fromId: from.id,
      toId: to.id,
      type: args.type,
      message: args.message,
      severity: args.severity ?? "INFO",
      taskId: args.taskId,
    },
  });

  const fromDef = getAgentDef(args.fromKey);
  const toDef = getAgentDef(args.toKey);
  await emitEvent({
    companyId: args.companyId,
    type: "CHAT",
    actor: args.fromKey,
    level: args.severity === "HIGH" || args.severity === "CRITICAL" ? "warning" : "info",
    message: `${fromDef?.name ?? args.fromKey} → ${toDef?.name ?? args.toKey}: [${args.type}] ${args.message.slice(0, 80)}`,
    meta: { messageId: msg.id, type: args.type, severity: args.severity },
  });

  return msg;
}

export async function listMessages(companyId: string, limit = 50) {
  return prisma.agentMessage.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      from: { select: { name: true, key: true, color: true, avatar: true } },
      to: { select: { name: true, key: true, color: true, avatar: true } },
    },
  });
}
