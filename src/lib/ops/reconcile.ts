/**
 * Turn rule outcomes into persisted OpsFinding rows.
 *
 *   fire on a new dedupe key       → create OPEN finding + ops event + maybe notify
 *   fire on an OPEN/ACK/INVEST key → update lastObservedAt/occurrences/evidence (no new event)
 *   fire on a RESOLVED key         → re-open (history records it)
 *   fire on a DISMISSED key        → stays dismissed; observation counted
 *   clear on an active finding     → RESOLVED by "rule" with the reason
 *   unknown                        → nothing persisted on the finding; reported on the evaluation run
 *
 * One row per (workspace, dedupeKey) is guaranteed by a unique index, so
 * concurrent evaluations cannot duplicate a finding.
 */
import { prisma } from "@/lib/db";
import { emitOpsEvent } from "@/lib/events/emit";
import { parseJSON } from "@/lib/utils";
import { dedupeKeyFor, type Rule, type RuleOutcome } from "./rules";
import { notifyForFinding, resolveNotification } from "./notify";

export const ACTIVE = ["OPEN", "ACKNOWLEDGED", "INVESTIGATING"] as const;

export interface ReconcileStats {
  opened: number;
  updated: number;
  resolved: number;
  reopened: number;
  unknown: { ruleId: string; resource: string; reason: string }[];
}

type HistoryEntry = { at: string; actor: string; change: string; detail?: string };
const pushHistory = (raw: string, e: HistoryEntry) => JSON.stringify([...parseJSON<HistoryEntry[]>(raw, []), e].slice(-50));

const SEV_RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const;

export async function reconcile(companyId: string, results: { rule: Rule; outcome: RuleOutcome }[], opts: { notifyMinSeverity?: string; now?: Date } = {}): Promise<ReconcileStats> {
  const now = opts.now ?? new Date();
  const stats: ReconcileStats = { opened: 0, updated: 0, resolved: 0, reopened: 0, unknown: [] };
  const existing = await prisma.opsFinding.findMany({ where: { companyId } });
  const byKey = new Map(existing.map((f) => [f.dedupeKey, f]));

  for (const { rule, outcome } of results) {
    const key = dedupeKeyFor(rule.id, outcome.resource);
    const f = byKey.get(key);

    if (outcome.kind === "unknown") {
      stats.unknown.push({ ruleId: rule.id, resource: `${outcome.resource.type}:${outcome.resource.label}`, reason: outcome.reason });
      continue;
    }

    if (outcome.kind === "clear") {
      if (f && (ACTIVE as readonly string[]).includes(f.status)) {
        await prisma.opsFinding.update({
          where: { id: f.id },
          data: { status: "RESOLVED", resolvedAt: now, resolvedBy: "rule", resolution: outcome.reason, history: pushHistory(f.history, { at: now.toISOString(), actor: "rule", change: "resolved", detail: `${rule.id}@v${rule.version}: ${outcome.reason}` }) },
        });
        await emitOpsEvent({ companyId, type: "OPS_FINDING", actor: "system", level: "success", message: `Resolved: ${f.title}`, meta: { findingId: f.id, ruleId: rule.id, reason: outcome.reason }, ops: { severity: "info", source: "ops", resourceType: f.resourceType, resourceId: f.resourceId, dedupeKey: key, resolution: "resolved" } });
        await resolveNotification(companyId, key);
        stats.resolved++;
      }
      continue;
    }

    // fire
    const data = {
      ruleVersion: rule.version,
      category: rule.category,
      certainty: outcome.certainty,
      severity: outcome.severity,
      severityReason: outcome.severityReason,
      title: outcome.title.slice(0, 200),
      explanation: outcome.explanation.slice(0, 1000),
      resourceType: outcome.resource.type,
      resourceId: outcome.resource.id,
      resourceLabel: outcome.resource.label.slice(0, 200),
      missionId: outcome.resource.missionId ?? null,
      evidence: JSON.stringify(outcome.evidence.slice(0, 20)),
      facts: JSON.stringify(outcome.facts),
      requiresHuman: outcome.requiresHuman,
      nextAction: outcome.nextAction,
      lastObservedAt: now,
    };

    if (!f) {
      const created = await prisma.opsFinding.upsert({
        where: { companyId_dedupeKey: { companyId, dedupeKey: key } },
        create: { companyId, ruleId: rule.id, dedupeKey: key, ...data, firstDetectedAt: now, history: JSON.stringify([{ at: now.toISOString(), actor: "rule", change: "opened", detail: `${rule.id}@v${rule.version}: ${outcome.severityReason}` }]) },
        update: { ...data, occurrences: { increment: 1 } }, // a concurrent evaluation created it first
      });
      byKey.set(key, created);
      await emitOpsEvent({ companyId, type: "OPS_FINDING", actor: "system", level: outcome.severity === "low" ? "info" : outcome.severity === "medium" ? "warning" : "danger", message: `${outcome.title}`, meta: { findingId: created.id, ruleId: rule.id }, ops: { severity: outcome.severity, source: "ops", resourceType: outcome.resource.type, resourceId: outcome.resource.id, dedupeKey: key, resolution: "open" } });
      await notifyForFinding(companyId, created, opts.notifyMinSeverity);
      stats.opened++;
      continue;
    }

    if (f.status === "DISMISSED") {
      await prisma.opsFinding.update({ where: { id: f.id }, data: { lastObservedAt: now, occurrences: { increment: 1 } } });
      continue;
    }

    if (f.status === "RESOLVED") {
      const reopened = await prisma.opsFinding.update({
        where: { id: f.id },
        data: { ...data, status: "OPEN", resolvedAt: null, resolvedBy: null, resolution: "", acknowledgedAt: null, acknowledgedBy: null, occurrences: { increment: 1 }, history: pushHistory(f.history, { at: now.toISOString(), actor: "rule", change: "reopened", detail: `${rule.id}@v${rule.version}: ${outcome.severityReason}` }) },
      });
      await emitOpsEvent({ companyId, type: "OPS_FINDING", actor: "system", level: "warning", message: `Re-opened: ${outcome.title}`, meta: { findingId: f.id, ruleId: rule.id }, ops: { severity: outcome.severity, source: "ops", resourceType: outcome.resource.type, resourceId: outcome.resource.id, dedupeKey: key, resolution: "open" } });
      await notifyForFinding(companyId, reopened, opts.notifyMinSeverity);
      stats.reopened++;
      continue;
    }

    // Still active: refresh evidence; record a severity change in history (no new event/notification otherwise).
    const severityChanged = f.severity !== outcome.severity;
    await prisma.opsFinding.update({
      where: { id: f.id },
      data: { ...data, occurrences: { increment: 1 }, ...(severityChanged ? { history: pushHistory(f.history, { at: now.toISOString(), actor: "rule", change: `severity ${f.severity} → ${outcome.severity}`, detail: outcome.severityReason }) } : {}) },
    });
    if (severityChanged && SEV_RANK[outcome.severity] > SEV_RANK[f.severity as keyof typeof SEV_RANK]) {
      await notifyForFinding(companyId, { ...f, ...data, severity: outcome.severity }, opts.notifyMinSeverity, true);
    }
    stats.updated++;
  }
  return stats;
}
