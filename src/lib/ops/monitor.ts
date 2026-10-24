/**
 * Operational health monitor.
 *
 * AURA has no server-side scheduler (serverless-safe by design: the sim clock
 * and mission engine are driven by bounded requests). The monitor follows the
 * same model:
 *   - event-driven: the mission engine requests an evaluation after each step
 *     (`requestEvaluation`, throttled to the configured interval);
 *   - scheduled reconciliation: the app shell sends a heartbeat; an evaluation
 *     runs only if the interval has elapsed since the last run;
 *   - manual: "Evaluate now" in the operations center.
 *
 * A lease on OpsMonitor prevents overlapping runs (compare-and-set); an
 * expired lease (crashed worker) is taken over. Evaluation is idempotent:
 * re-running over unchanged state changes nothing (unique dedupe keys). Each
 * run is recorded as an OpsEvaluation, including rules that returned
 * "unknown" for lack of evidence. No model call is made here.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { emitEvent } from "@/lib/events/emit";
import { parseJSON } from "@/lib/utils";
import { evaluateRules, DEFAULT_THRESHOLDS, type Thresholds } from "./rules";
import { loadSnapshot } from "./snapshot";
import { reconcile, ACTIVE } from "./reconcile";
import { recommendationsFor, executeAction, ACTIONS, type PolicyLevel } from "./actions";

const LEASE_MS = 60_000;
const MAX_AUTO_PER_RUN = 3;
export const MIN_INTERVAL_SEC = 30;

export async function getMonitor(companyId: string) {
  return prisma.opsMonitor.upsert({ where: { companyId }, create: { companyId }, update: {} });
}

export interface EvaluationResult {
  ran: boolean;
  reason?: string;
  evaluationId?: string;
  opened?: number;
  updated?: number;
  resolved?: number;
  reopened?: number;
  unknown?: number;
  autoActions?: number;
}

/**
 * Run one evaluation if allowed. `force` skips the interval check (manual
 * runs) but never the lease. Returns without running when disabled, too soon,
 * or another worker holds the lease.
 */
export async function runEvaluation(companyId: string, trigger: "scheduled" | "event" | "manual", opts: { force?: boolean; now?: Date; probe?: boolean } = {}): Promise<EvaluationResult> {
  const mon = await getMonitor(companyId);
  if (!mon.enabled && trigger !== "manual") return { ran: false, reason: "monitoring disabled" };
  const now = opts.now ?? new Date();
  if (!opts.force && mon.lastRunAt && now.getTime() - mon.lastRunAt.getTime() < Math.max(MIN_INTERVAL_SEC, mon.intervalSec) * 1000) {
    return { ran: false, reason: "interval not elapsed" };
  }

  const worker = randomUUID();
  const got = await prisma.opsMonitor.updateMany({
    where: { companyId, OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now } }] },
    data: { leaseOwner: worker, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
  });
  if (got.count !== 1) return { ran: false, reason: "another evaluation is running" };

  const started = Date.now();
  const evalRow = await prisma.opsEvaluation.create({ data: { companyId, trigger } });
  try {
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, ...parseJSON<Partial<Thresholds>>(mon.thresholds, {}) };
    const snap = await loadSnapshot(companyId, { now, probe: opts.probe });
    const results = evaluateRules(snap, thresholds);
    const stats = await reconcile(companyId, results, { notifyMinSeverity: mon.notifyMinSeverity, now });

    // Bounded autonomy: only BOUNDED/CONTINUOUS, only allow-listed low-risk actions, rate-limited, capped per run.
    let autoActions = 0;
    const level = mon.policyLevel as PolicyLevel;
    const allow = parseJSON<string[]>(mon.allowedAutoActions, []);
    if ((level === "BOUNDED" || level === "CONTINUOUS") && allow.length) {
      const open = await prisma.opsFinding.findMany({ where: { companyId, status: { in: [...ACTIVE] } }, orderBy: { lastObservedAt: "desc" }, take: 20 });
      for (const f of open) {
        if (autoActions >= MAX_AUTO_PER_RUN) break;
        const recs = (await recommendationsFor(f)).filter((r) => !r.unavailable && allow.includes(r.action) && ACTIONS[r.action].autoEligible);
        for (const r of recs) {
          // Idempotency: never repeat the same automatic action on the same target for the same open finding.
          const prior = await prisma.opsAction.findFirst({ where: { companyId, findingId: f.id, actionType: r.action, trigger: "automatic", target: JSON.stringify(r.target) } });
          if (prior) continue;
          const res = await executeAction({ companyId, action: r.action, target: r.target, findingId: f.id, actor: "monitor", trigger: "automatic" });
          if (res.decision.decision === "allowed") autoActions++;
          break;
        }
      }
    }

    await prisma.opsEvaluation.update({
      where: { id: evalRow.id },
      data: { status: "COMPLETED", rulesRun: results.length, opened: stats.opened, updated: stats.updated, resolved: stats.resolved, reopened: stats.reopened, unknown: JSON.stringify(stats.unknown.slice(0, 100)), autoActions, durationMs: Date.now() - started, completedAt: new Date() },
    });
    await prisma.opsMonitor.update({ where: { companyId }, data: { lastRunAt: now, lastRunId: evalRow.id } });
    if (stats.opened || stats.resolved || stats.reopened) {
      await emitEvent({ companyId, type: "OPS_MONITOR", actor: "system", level: "info", message: `Health evaluation: ${stats.opened} opened, ${stats.resolved} resolved, ${stats.reopened} re-opened`, meta: { evaluationId: evalRow.id }, ops: { severity: "info", source: "ops" } });
    }
    return { ran: true, evaluationId: evalRow.id, opened: stats.opened, updated: stats.updated, resolved: stats.resolved, reopened: stats.reopened, unknown: stats.unknown.length, autoActions };
  } catch (e) {
    await prisma.opsEvaluation.update({ where: { id: evalRow.id }, data: { status: "FAILED", error: (e as Error).message.slice(0, 1000), durationMs: Date.now() - started, completedAt: new Date() } });
    throw e;
  } finally {
    // Release only our own lease.
    await prisma.opsMonitor.updateMany({ where: { companyId, leaseOwner: worker }, data: { leaseOwner: null, leaseExpiresAt: null } });
  }
}

/**
 * Event-driven trigger used by the mission engine after a step. Never throws
 * into the caller and never blocks mission progress on a monitoring failure.
 */
export async function requestEvaluation(companyId: string) {
  try {
    await runEvaluation(companyId, "event");
  } catch {
    /* recorded on the OpsEvaluation row */
  }
}
