import { prisma } from "@/lib/db";
import { publish } from "./bus";
import type { EventType, LiveEvent } from "@/lib/types";
import { getAgentDef } from "@/lib/agents/definitions";

interface EmitInput {
  companyId: string;
  type: EventType;
  message: string;
  actor?: string; // agent key or "system"
  level?: LiveEvent["level"];
  meta?: Record<string, unknown>;
  simDay?: number;
  persist?: boolean; // default true
  /** Operational fields — see OpsEventInput. */
  ops?: OpsFields;
}

export interface OpsFields {
  severity: "info" | "low" | "medium" | "high" | "critical";
  source: "missions" | "agents" | "sandbox" | "deploy" | "security" | "evaluation" | "ops";
  resourceType?: string;
  resourceId?: string;
  dedupeKey?: string;
  resolution?: "open" | "resolved";
}

/**
 * Emit a live event: persist to DB (for the activity feed / audit) AND publish
 * to the in-memory bus (for SSE subscribers). Returns the LiveEvent.
 */
export async function emitEvent(input: EmitInput): Promise<LiveEvent> {
  const def = input.actor ? getAgentDef(input.actor) : undefined;
  const level = input.level ?? "info";
  const persist = input.persist ?? true;

  let id = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let createdAt = new Date();

  if (persist) {
    const row = await prisma.simulationEvent.create({
      data: {
        companyId: input.companyId,
        type: input.type,
        actor: input.actor,
        actorName: def?.name,
        role: def?.role,
        message: input.message,
        level,
        meta: JSON.stringify(input.meta ?? {}),
        simDay: input.simDay ?? 0,
        ...(input.ops ?? {}),
      },
    });
    id = row.id;
    createdAt = row.createdAt;
  }

  const event: LiveEvent = {
    id,
    companyId: input.companyId,
    type: input.type,
    actor: input.actor,
    actorName: def?.name,
    role: def?.role,
    message: input.message,
    level,
    meta: input.meta,
    createdAt: createdAt.toISOString(),
  };
  publish(event);
  return event;
}

/**
 * Emit an operational event at most once per dedupe key while it stays in the
 * same resolution state (repeated observations of an open condition are not
 * new events). Payloads carry references, never raw logs or secrets.
 */
export async function emitOpsEvent(input: Omit<EmitInput, "ops"> & { ops: OpsFields & { dedupeKey: string } }): Promise<LiveEvent | null> {
  const last = await prisma.simulationEvent.findFirst({ where: { companyId: input.companyId, dedupeKey: input.ops.dedupeKey }, orderBy: { createdAt: "desc" }, select: { resolution: true } });
  if (last && last.resolution === (input.ops.resolution ?? "open")) return null;
  return emitEvent(input);
}

/** Append an immutable audit log entry. */
export async function audit(companyId: string, actor: string, action: string, target: string, result: string) {
  await prisma.auditLog.create({
    data: { companyId, actor, action, target, result },
  });
}
