/**
 * Circuit breakers (persisted, per workspace + scope). A scope opens after
 * `threshold` consecutive failures and stays open for `coolMs`; the next
 * attempt after that is a HALF_OPEN probe — success closes it, failure
 * re-opens it. The queue refuses to claim jobs whose `job:<type>` breaker is
 * open, so a broken provider or a repeatedly failing job type stops burning
 * attempts and budget.
 *
 * Scopes used:  job:<type>  ·  provider:anthropic  ·  goal:<id>
 */
import { prisma } from "@/lib/db";
import { log } from "@/lib/observability/log";

export const BREAKER = { threshold: Number(process.env.AURA_BREAKER_THRESHOLD || 5), coolMs: Number(process.env.AURA_BREAKER_COOL_MS || 10 * 60_000) };

export async function recordOutcome(companyId: string, scope: string, ok: boolean, reason = "") {
  const b = await prisma.circuitBreaker.upsert({ where: { companyId_scope: { companyId, scope } }, create: { companyId, scope }, update: {} });
  if (ok) {
    if (b.failures || b.state !== "CLOSED") await prisma.circuitBreaker.update({ where: { id: b.id }, data: { state: "CLOSED", failures: 0, reason: "", openedAt: null, reopenAt: null } });
    return "CLOSED";
  }
  const failures = b.failures + 1;
  const open = b.state === "HALF_OPEN" || failures >= BREAKER.threshold;
  await prisma.circuitBreaker.update({ where: { id: b.id }, data: { failures, reason: reason.slice(0, 500), ...(open ? { state: "OPEN", openedAt: new Date(), reopenAt: new Date(Date.now() + BREAKER.coolMs) } : {}) } });
  if (open && b.state !== "OPEN") log("error", "breaker.opened", { companyId, scope, failures, reason: reason.slice(0, 200) });
  return open ? "OPEN" : b.state;
}

/** Move OPEN breakers whose cool-down elapsed to HALF_OPEN (one probe allowed). Called by the scheduler tick. */
export async function halfOpenDue() {
  const r = await prisma.circuitBreaker.updateMany({ where: { state: "OPEN", reopenAt: { lt: new Date() } }, data: { state: "HALF_OPEN" } });
  return r.count;
}

export async function isOpen(companyId: string, scope: string) {
  const b = await prisma.circuitBreaker.findUnique({ where: { companyId_scope: { companyId, scope } } });
  return !!b && b.state === "OPEN" && (!b.reopenAt || b.reopenAt > new Date());
}

/** An authorized person resets a breaker (after fixing the cause). */
export async function resetBreaker(companyId: string, scope: string) {
  await prisma.circuitBreaker.updateMany({ where: { companyId, scope }, data: { state: "CLOSED", failures: 0, reason: "", openedAt: null, reopenAt: null } });
}
