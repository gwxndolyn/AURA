/**
 * Schedules: recurring or deferred work, persisted. The scheduler tick
 * (run by every worker; protected by a per-schedule lease so only one worker
 * fires a slot) enqueues one job per due slot with a dedupe key derived from
 * the slot time — a slot fires at most once even if two workers race or the
 * tick runs twice. Missed slots while every worker was down are NOT replayed
 * one by one: the schedule fires once on recovery and moves to the next
 * future slot (catch-up storms would hammer the provider and budget).
 *
 * Specs (UTC):
 *   "every 15m" | "every 2h" | "every 1d"
 *   "m h dom mon dow"  five-field cron: numbers, *, lists (1,2), ranges (1-5), steps (*\/15)
 *   "once 2026-10-24T09:00:00Z"
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { enqueue } from "@/lib/jobs/queue";
import { log } from "@/lib/observability/log";

function field(expr: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of expr.split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS ? Number(stepS) : 1;
    if (!Number.isInteger(step) || step < 1) throw new ApiError(`bad step in "${part}"`, 422);
    const [a, b] = range === "*" ? [min, max] : range.includes("-") ? range.split("-").map(Number) : [Number(range), stepS ? max : Number(range)];
    if (![a, b].every((n) => Number.isInteger(n) && n >= min && n <= max) || a > b) throw new ApiError(`bad cron field "${part}" (allowed ${min}-${max})`, 422);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** Next run strictly after `from`, or null when the schedule is finished. Throws ApiError on an invalid spec. */
export function nextRun(spec: string, from: Date): Date | null {
  const s = spec.trim();
  const every = s.match(/^every\s+(\d+)\s*([mhd])$/i);
  if (every) {
    const n = Number(every[1]);
    const ms = n * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as Record<string, number>)[every[2].toLowerCase()];
    if (!n || ms < 60_000) throw new ApiError("Interval must be at least 1 minute", 422);
    return new Date(Math.floor(from.getTime() / ms) * ms + ms);
  }
  const once = s.match(/^once\s+(.+)$/i);
  if (once) {
    const t = new Date(once[1]);
    if (Number.isNaN(t.getTime())) throw new ApiError("Invalid date for a one-time schedule", 422);
    return t > from ? t : null;
  }
  const parts = s.split(/\s+/);
  if (parts.length !== 5) throw new ApiError('Schedule must be "every N[m|h|d]", "once <ISO date>" or a 5-field cron expression', 422);
  const [mi, ho, dom, mon, dow] = [field(parts[0], 0, 59), field(parts[1], 0, 23), field(parts[2], 1, 31), field(parts[3], 1, 12), field(parts[4], 0, 6)];
  const t = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (mi.has(t.getUTCMinutes()) && ho.has(t.getUTCHours()) && dom.has(t.getUTCDate()) && mon.has(t.getUTCMonth() + 1) && dow.has(t.getUTCDay())) return t;
    t.setTime(t.getTime() + 60_000);
  }
  return null;
}

export async function createSchedule(input: { companyId: string; name: string; jobType: string; payload: Record<string, unknown>; spec: string; createdBy: string }) {
  const next = nextRun(input.spec, new Date());
  if (!next) throw new ApiError("The schedule has no future run", 422);
  return prisma.schedule.create({ data: { companyId: input.companyId, name: input.name.slice(0, 120), jobType: input.jobType, payload: JSON.stringify(input.payload), spec: input.spec.trim(), nextRunAt: next, createdBy: input.createdBy } });
}

/** One scheduler pass: fire every due, enabled schedule exactly once per slot. */
export async function tickSchedules(worker: string, now = new Date()) {
  const due = await prisma.schedule.findMany({ where: { enabled: true, nextRunAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, take: 50 });
  const fired: string[] = [];
  for (const s of due) {
    // Compare-and-set on the SLOT as well as the lease: a tick working from a stale read (another tick already
    // fired this slot, released the lease and advanced nextRunAt) must not fire it again.
    const lease = await prisma.schedule.updateMany({ where: { id: s.id, enabled: true, nextRunAt: s.nextRunAt, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseUntil: new Date(now.getTime() + 60_000) } });
    if (lease.count !== 1) continue;
    try {
      const slot = s.nextRunAt!;
      const job = await enqueue({ companyId: s.companyId, type: s.jobType, payload: JSON.parse(s.payload), dedupeKey: `sched:${s.id}:${slot.toISOString()}`, createdBy: `schedule:${s.id}`, scheduleId: s.id, maxAttempts: 2 });
      let next: Date | null = null;
      try { next = nextRun(s.spec, now); } catch { next = null; }
      await prisma.schedule.update({ where: { id: s.id }, data: { lastRunAt: now, lastJobId: job.id, runs: { increment: 1 }, nextRunAt: next, enabled: next !== null, leaseUntil: null } });
      fired.push(s.id);
    } catch (e) {
      log("error", "schedule.fire_failed", { scheduleId: s.id, worker, error: (e as Error).message.slice(0, 300) });
      await prisma.schedule.update({ where: { id: s.id }, data: { leaseUntil: null } });
    }
  }
  return fired;
}
