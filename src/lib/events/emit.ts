import { prisma } from "@/lib/db";
import { publish } from "./bus";
import type { EventType, LiveEvent } from "@/lib/types";
import { getAgentDef } from "@/lib/agents/definitions";
import { redactText, redactValue } from "@/lib/security/redact";

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

export const AUDIT_CATEGORIES = ["security", "membership", "billing", "integration", "execution", "deployment", "secret", "data", "activity"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** Category from the action name, so the 90+ existing call sites are classified without changes. */
export function auditCategory(action: string): AuditCategory {
  const a = action.toUpperCase();
  if (/^(LOGIN|LOGOUT|SESSION|PASSWORD|EMAIL_VERIF|ACCESS_DENIED|AUTH)/.test(a)) return "security";
  if (/(MEMBER|INVITE|INVITATION|ROLE|OWNERSHIP)/.test(a)) return "membership";
  if (/(BILLING|SUBSCRIPTION|CHECKOUT|PLAN_|INVOICE|SPEND)/.test(a)) return "billing";
  if (/SECRET/.test(a)) return "secret";
  if (/(GITHUB|INTEGRATION|WEBHOOK|PROVIDER)/.test(a)) return "integration";
  if (/(DEPLOY|ROLLBACK|RELEASE)/.test(a)) return "deployment";
  if (/(EXPORT|DELET|ARCHIV|RESTOR|RETENTION|PURGE)/.test(a)) return "data";
  if (/(BUILD|RUN|MISSION|GOAL|JOB|PRODUCT_(PAUSE|RESUME|CANCEL)|APPROVAL|EXECUT)/.test(a)) return "execution";
  return "activity";
}

/**
 * Append an immutable audit log entry. Text is redacted (no secret values ever
 * reach the audit trail). Rows are never updated or deleted by application code.
 */
export async function audit(companyId: string, actor: string, action: string, target: string, result: string, opts: { outcome?: "success" | "denied" | "failure"; category?: AuditCategory; meta?: Record<string, unknown> } = {}) {
  await prisma.auditLog.create({
    data: {
      companyId,
      actor: redactText(actor).slice(0, 200),
      action: action.slice(0, 80),
      target: redactText(target).slice(0, 300),
      result: redactText(result).slice(0, 1000),
      category: opts.category ?? auditCategory(action),
      outcome: opts.outcome ?? "success",
      meta: JSON.stringify(redactValue(opts.meta ?? {})).slice(0, 4000),
    },
  });
}
