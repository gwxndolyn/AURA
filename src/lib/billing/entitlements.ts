/**
 * Entitlements, quota reservations and the usage ledger. Server-side only:
 * limits are evaluated from the persisted Subscription (written by verified
 * Stripe webhooks) and AURA's own counters — never from anything the browser says.
 *
 * Concurrency model (why parallel requests cannot exceed a quota):
 *   UsageCounter holds `used` + `reserved` per (workspace, metric, period).
 *   reserve() is a compare-and-swap: read the counter, check
 *   used + reserved + q <= limit, then `updateMany({ where: { id, version } })`
 *   which increments `reserved` and `version` only if nobody else wrote the row
 *   in between (one atomic conditional UPDATE in SQLite and PostgreSQL). A
 *   writer that loses the race re-reads and re-checks, so two parallel requests
 *   can never both take the last unit; the loser gets 402.
 *   A UsageReservation row records each hold (RESERVED → SETTLED | RELEASED).
 *   Expired holds (crashed/abandoned work) are released by recoverReservations().
 *
 * Ledger: UsageEvent rows are the detailed, idempotent record (unique
 * idempotencyKey — retries and duplicate events never double-count). Each
 * ledger write also bumps the matching counter's `used` in the same transaction.
 * The `basis` column says how a quantity is known: provider_reported (tokens,
 * durations), estimated (cost at list prices — never presented as an invoice
 * amount), counted (runs, products, deploys).
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { log } from "@/lib/observability/log";
import { planOf, ENTITLED_STATUSES, type Plan, type FeatureKey } from "./plans";

export class QuotaError extends ApiError {
  constructor(message: string, public limit: string, public upgrade = true) {
    super(message, 402);
    this.name = "QuotaError";
  }
}

export async function subscriptionOf(companyId: string) {
  try {
    return await prisma.subscription.upsert({ where: { companyId }, create: { companyId }, update: {} });
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
    return prisma.subscription.findUniqueOrThrow({ where: { companyId } });
  }
}

/** The plan whose entitlements currently apply (free if the paid subscription isn't in good standing). */
export async function effectivePlan(companyId: string): Promise<{ plan: Plan; status: string; subscription: Awaited<ReturnType<typeof subscriptionOf>> }> {
  const sub = await subscriptionOf(companyId);
  const paidOk = ENTITLED_STATUSES.includes(sub.status);
  return { plan: planOf(paidOk ? sub.plan : "free"), status: sub.status, subscription: sub };
}

export const periodOf = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

/** Metrics that gate work, and how their limit is derived. "live" metrics are gauges (not monthly). */
export const GATED = {
  build: { period: "month", limit: (p: Plan) => p.limits.buildsPerMonth, label: "engineering runs this month", key: "buildsPerMonth" },
  concurrent_build: { period: "live", limit: (p: Plan) => p.limits.concurrentBuilds, label: "engineering runs at the same time", key: "concurrentBuilds" },
  deploy: { period: "month", limit: (p: Plan) => p.limits.deploysPerMonth, label: "deployments this month", key: "deploysPerMonth" },
  ai_cost_usd: { period: "month", limit: (p: Plan) => p.limits.aiBudgetUsdPerMonth, label: "AI usage this month (USD, estimated)", key: "aiBudgetUsdPerMonth" },
  sandbox_ms: { period: "month", limit: (p: Plan) => p.limits.sandboxMinutesPerMonth * 60_000, label: "sandbox time this month", key: "sandboxMinutesPerMonth" },
} as const;
export type GatedMetric = keyof typeof GATED;

const periodFor = (m: GatedMetric, now = new Date()) => (GATED[m].period === "live" ? "live" : periodOf(now));

type Counter = { id: string; used: number; reserved: number; version: number };

/**
 * Compare-and-swap on one counter row: `next` sees the current values and
 * returns the new ones (or throws to refuse). The write applies only if the
 * row's version is unchanged; otherwise re-read and re-decide.
 */
async function casCounter(companyId: string, metric: string, period: string, next: (c: Counter) => { used?: number; reserved?: number }) {
  await ensureCounter(companyId, metric, period);
  for (let i = 0; i < 50; i++) {
    const c = await prisma.usageCounter.findUniqueOrThrow({ where: { companyId_metric_period: { companyId, metric, period } } });
    const v = next(c);
    const n = await prisma.usageCounter.updateMany({ where: { id: c.id, version: c.version }, data: { ...v, version: { increment: 1 } } });
    if (n.count === 1) return;
    await new Promise((r) => setTimeout(r, Math.random() * 10 * (i + 1)));
  }
  throw new ApiError("Usage accounting is busy; try again", 503);
}

async function ensureCounter(companyId: string, metric: string, period: string) {
  try {
    await prisma.usageCounter.upsert({ where: { companyId_metric_period: { companyId, metric, period } }, create: { companyId, metric, period }, update: {} });
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e; // a parallel request created it first
  }
}

/** Customer spending cap (Settings → Usage): the AI budget is min(plan allowance, cap). */
async function aiLimit(companyId: string, plan: Plan) {
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { monthlyBudgetUsd: true } });
  return Math.min(plan.limits.aiBudgetUsdPerMonth, c?.monthlyBudgetUsd ?? Infinity);
}

async function limitFor(companyId: string, plan: Plan, metric: GatedMetric) {
  return metric === "ai_cost_usd" ? aiLimit(companyId, plan) : GATED[metric].limit(plan);
}

/**
 * Atomically reserve `quantity` of a gated metric for `ref` (e.g. "build:<id>").
 * Idempotent per (ref, metric): reserving again returns the existing hold.
 * Throws QuotaError (402) with an upgrade explanation when the limit would be exceeded.
 */
export async function reserve(companyId: string, metric: GatedMetric, ref: string, quantity = 1, opts: { ttlMs?: number; plan?: Plan } = {}) {
  const existing = await prisma.usageReservation.findUnique({ where: { ref_metric: { ref, metric } } });
  if (existing && existing.status === "RESERVED") return existing;
  const plan = opts.plan ?? (await effectivePlan(companyId)).plan;
  const limit = await limitFor(companyId, plan, metric);
  const period = periodFor(metric);
  await casCounter(companyId, metric, period, (c) => {
    if (c.used + c.reserved + quantity > limit + 1e-9) {
      log("info", "quota.denied", { companyId, metric, limit, used: c.used, reserved: c.reserved });
      throw new QuotaError(quotaMessage(metric, plan, limit, c.used, c.reserved), GATED[metric].key);
    }
    return { reserved: c.reserved + quantity };
  });
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? 6 * 3600_000));
  try {
    if (existing) return await prisma.usageReservation.update({ where: { id: existing.id }, data: { status: "RESERVED", quantity, period, consumed: 0, expiresAt, settledAt: null } });
    return await prisma.usageReservation.create({ data: { companyId, metric, period, quantity, ref, expiresAt } });
  } catch (e) {
    // Lost a race to create the same hold: give our increment back and return the winner's hold.
    await casCounter(companyId, metric, period, (c) => ({ reserved: Math.max(0, c.reserved - quantity) }));
    if ((e as { code?: string }).code === "P2002") return prisma.usageReservation.findUniqueOrThrow({ where: { ref_metric: { ref, metric } } });
    throw e;
  }
}

function quotaMessage(metric: GatedMetric, plan: Plan, limit: number, used: number, reserved: number) {
  const spec = GATED[metric];
  const fmt = (v: number) => (metric === "ai_cost_usd" ? `$${v.toFixed(2)}` : metric === "sandbox_ms" ? `${Math.round(v / 60_000)} min` : String(Math.round(v)));
  const inFlight = reserved > 0 ? ` (${fmt(reserved)} held by work in progress)` : "";
  if (metric === "concurrent_build") return `Your ${plan.name} plan runs ${limit} engineering run(s) at a time; wait for the current one to finish${plan.id !== "team" ? " or upgrade for more parallel runs" : ""}.`;
  if (metric === "ai_cost_usd" && limit < plan.limits.aiBudgetUsdPerMonth) return `Your workspace spending cap of ${fmt(limit)} for ${spec.label} is reached (${fmt(used)} used${inFlight}). An admin can raise it in Settings → Usage.`;
  return `Limit reached: ${fmt(used)} of ${fmt(limit)} ${spec.label} on the ${plan.name} plan${inFlight}. ${plan.id === "team" ? "Contact support to raise it." : "Upgrade in Settings → Billing, or wait for the next billing period."}`;
}

/**
 * Release a hold. With `consumed` (the quantity actually used, ≥ 0) the hold is
 * SETTLED: `consumed` moves to used (unless `alreadyCounted` — the ledger
 * recorded it already). Without it, the hold is RELEASED: nothing counted.
 * Idempotent: only a RESERVED hold changes (conditional update).
 */
export async function settle(ref: string, metric: GatedMetric, consumed: number | null, opts: { alreadyCounted?: boolean } = {}) {
  const r = await prisma.usageReservation.findUnique({ where: { ref_metric: { ref, metric } } });
  if (!r || r.status !== "RESERVED") return null;
  const status = consumed === null ? "RELEASED" : "SETTLED";
  const moved = await prisma.usageReservation.updateMany({ where: { id: r.id, status: "RESERVED" }, data: { status, consumed: consumed ?? 0, settledAt: new Date() } });
  if (moved.count !== 1) return null;
  const add = consumed !== null && !opts.alreadyCounted && GATED[metric].period !== "live" ? consumed : 0;
  await casCounter(r.companyId, metric, r.period, (c) => ({ reserved: Math.max(0, c.reserved - r.quantity), used: c.used + add }));
  return status;
}

/** Release every hold attached to a ref (e.g. all metrics of one build). */
export async function releaseAll(ref: string) {
  const rows = await prisma.usageReservation.findMany({ where: { ref, status: "RESERVED" } });
  for (const r of rows) await settle(ref, r.metric as GatedMetric, null);
  return rows.length;
}

/**
 * Crash recovery: holds past their expiry belonged to work that died or was
 * abandoned — release them so the customer's quota is not leaked. Also
 * releases live holds whose build is no longer running.
 */
export async function recoverReservations(now = new Date()) {
  const expired = await prisma.usageReservation.findMany({ where: { status: "RESERVED", expiresAt: { lt: now } }, take: 500 });
  let released = 0;
  for (const r of expired) if (await settle(r.ref, r.metric as GatedMetric, null)) released++;
  const live = await prisma.usageReservation.findMany({ where: { status: "RESERVED", metric: "concurrent_build" }, take: 500 });
  for (const r of live) {
    const id = r.ref.startsWith("build:") ? r.ref.slice(6) : null;
    if (!id) continue;
    const b = await prisma.build.findUnique({ where: { id }, select: { status: true } });
    if (!b || !["QUEUED", "RUNNING"].includes(b.status)) if (await settle(r.ref, "concurrent_build", null)) released++;
  }
  if (released) log("warn", "quota.reservations_recovered", { released });
  return released;
}

export interface UsageEntry { metric: string; quantity: number; basis?: "provider_reported" | "estimated" | "counted"; model?: string }

/**
 * Append to the usage ledger. `source` identifies the operation; with
 * `idempotencyKey` (default: source + metric) a retried or duplicated write is
 * ignored instead of double-counted. Each new row also bumps the gating counter.
 */
export async function recordUsage(companyId: string, entries: UsageEntry[], source: string, ctx: { userId?: string; productId?: string; idempotencyKey?: string } = {}) {
  const period = periodOf();
  let written = 0;
  for (const e of entries) {
    if (!Number.isFinite(e.quantity) || e.quantity <= 0) continue;
    const key = `${ctx.idempotencyKey ?? source}:${e.metric}`;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.usageEvent.create({ data: { companyId, metric: e.metric, quantity: e.quantity, source, idempotencyKey: key, userId: ctx.userId ?? null, productId: ctx.productId ?? null, model: e.model ?? null, basis: e.basis ?? (e.metric === "ai_cost_usd" ? "estimated" : e.metric.startsWith("ai_tokens") || e.metric.endsWith("_ms") ? "provider_reported" : "counted"), period } });
        if (e.metric in GATED && GATED[e.metric as GatedMetric].period === "month") {
          await tx.usageCounter.upsert({ where: { companyId_metric_period: { companyId, metric: e.metric, period } }, create: { companyId, metric: e.metric, period, used: e.quantity }, update: { used: { increment: e.quantity }, version: { increment: 1 } } });
        }
      });
      written++;
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") continue; // duplicate → already counted
      throw err;
    }
  }
  return written;
}

export async function usageThisMonth(companyId: string) {
  const period = periodOf();
  const rows = await prisma.usageEvent.groupBy({ by: ["metric"], where: { companyId, createdAt: { gte: monthStart() } }, _sum: { quantity: true } });
  const counters = await prisma.usageCounter.findMany({ where: { companyId, period: { in: [period, "live"] } } });
  const get = (m: string) => rows.find((r) => r.metric === m)?._sum.quantity ?? 0;
  const reserved = (m: string) => counters.find((c) => c.metric === m)?.reserved ?? 0;
  return {
    since: monthStart().toISOString(),
    period,
    builds: get("build"),
    deploys: get("deploy"),
    aiCostUsd: get("ai_cost_usd"),
    tokensIn: get("ai_tokens_in"),
    tokensOut: get("ai_tokens_out"),
    sandboxMinutes: get("sandbox_ms") / 60_000,
    reserved: { builds: reserved("build"), concurrentBuilds: reserved("concurrent_build"), aiCostUsd: reserved("ai_cost_usd") },
    costBasis: "estimated from provider-reported tokens at list prices",
  };
}

/** Make the monthly counters agree with the ledger (repair after manual DB edits; the ledger is the record). */
export async function reconcileCounters(companyId: string) {
  const period = periodOf();
  const rows = await prisma.usageEvent.groupBy({ by: ["metric"], where: { companyId, period }, _sum: { quantity: true } });
  const fixed: string[] = [];
  for (const m of Object.keys(GATED) as GatedMetric[]) {
    if (GATED[m].period !== "month") continue;
    const truth = rows.find((r) => r.metric === m)?._sum.quantity ?? 0;
    await ensureCounter(companyId, m, period);
    const c = await prisma.usageCounter.findUniqueOrThrow({ where: { companyId_metric_period: { companyId, metric: m, period } } });
    if (Math.abs(c.used - truth) > 1e-9) {
      const n = await prisma.usageCounter.updateMany({ where: { id: c.id, version: c.version }, data: { used: truth, version: { increment: 1 } } });
      if (n.count) fixed.push(`${m}: ${c.used} → ${truth}`);
    }
  }
  if (fixed.length) log("warn", "quota.reconciled", { companyId, fixed });
  return fixed;
}

const FEATURE_MESSAGES: Record<string, [FeatureKey, string]> = {
  github: ["githubIntegration", "GitHub integration"],
  pull_request: ["pullRequests", "Pull requests"],
  deploy_request: ["deploymentRequests", "Deployments"],
  deploy_production: ["productionDeploys", "Production deployments"],
  advanced_agents: ["advancedAgents", "The engineering lab and autonomous goals"],
};

export async function assertFeature(companyId: string, what: keyof typeof FEATURE_MESSAGES) {
  const { plan } = await effectivePlan(companyId);
  const [key, label] = FEATURE_MESSAGES[what];
  if (!plan.features[key]) throw new QuotaError(`${label} ${label.endsWith("s") ? "are" : "is"} available on paid plans (not included in ${plan.name}). Upgrade in Settings → Billing.`, key);
  return plan;
}

/** Seats used = members + pending invitations. */
export async function seatsInUse(companyId: string) {
  const [members, invites] = await Promise.all([
    prisma.workspaceMember.count({ where: { companyId } }),
    prisma.invitation.count({ where: { companyId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
  ]);
  return members + invites;
}

/**
 * Gate for count-based limits (products, seats, integrations) and features.
 * Run-quota checks use reserve() instead (atomic).
 */
export async function assertCanStart(companyId: string, what: "product" | "build" | "github" | "pull_request" | "deploy_request" | "seat") {
  const { plan } = await effectivePlan(companyId);
  if (what === "github") {
    await assertFeature(companyId, "github");
    const n = await prisma.githubInstallation.count({ where: { companyId, status: "ACTIVE" } });
    if (n >= plan.limits.githubConnections) throw new QuotaError(`Your ${plan.name} plan allows ${plan.limits.githubConnections} GitHub connection(s). Disconnect one or upgrade.`, "githubConnections");
    return;
  }
  if (what === "pull_request") return void (await assertFeature(companyId, "pull_request"));
  if (what === "deploy_request") return void (await assertFeature(companyId, "deploy_request"));
  if (what === "seat") {
    const n = await seatsInUse(companyId);
    if (n >= plan.limits.seats) throw new QuotaError(`Your ${plan.name} plan includes ${plan.limits.seats} seat(s) and ${n} are in use (members + pending invitations). Upgrade or remove someone first.`, "seats");
    return;
  }
  if (what === "product") {
    const n = await prisma.product.count({ where: { companyId, status: { notIn: ["CANCELLED", "ARCHIVED"] } } });
    if (n >= plan.limits.products) throw new QuotaError(`Your ${plan.name} plan includes ${plan.limits.products} active product(s). Upgrade, or archive or cancel a product to create another.`, "products");
    return;
  }
  // "build": a non-reserving pre-check (fast refusal + retries); startBuild then reserves atomically.
  const u = await usageThisMonth(companyId);
  if (u.builds + u.reserved.builds >= plan.limits.buildsPerMonth) throw new QuotaError(quotaMessage("build", plan, plan.limits.buildsPerMonth, u.builds, u.reserved.builds), "buildsPerMonth");
  if (u.aiCostUsd >= (await aiLimit(companyId, plan))) throw new QuotaError(quotaMessage("ai_cost_usd", plan, await aiLimit(companyId, plan), u.aiCostUsd, 0), "aiBudgetUsdPerMonth");
  if (u.sandboxMinutes >= plan.limits.sandboxMinutesPerMonth) throw new QuotaError(quotaMessage("sandbox_ms", plan, plan.limits.sandboxMinutesPerMonth * 60_000, u.sandboxMinutes * 60_000, 0), "sandboxMinutesPerMonth");
}

/** Remaining AI budget for this month (USD) — the hard stop the builder checks before each model turn. */
export async function remainingAiBudget(companyId: string) {
  const { plan } = await effectivePlan(companyId);
  const u = await usageThisMonth(companyId);
  return Math.max(0, (await aiLimit(companyId, plan)) - u.aiCostUsd);
}
