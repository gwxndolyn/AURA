/**
 * Plan catalogue — the single source of truth for pricing, limits and
 * entitlements. Defaults live in config/plans.json (data, not code). An
 * operator can replace the commercial terms without a code change by pointing
 * AURA_PLANS_FILE at another JSON file with the same shape; it is validated at
 * load and a malformed file falls back to the defaults with an error log
 * (never silently granting unlimited access).
 *
 * The Stripe price for each paid plan comes from the server env
 * (STRIPE_PRICE_<PLAN> monthly, STRIPE_PRICE_<PLAN>_YEARLY annual); display
 * prices must match what is configured in Stripe. Nothing else in the codebase
 * hardcodes a limit.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import defaults from "../../../config/plans.json";

export type PlanId = "free" | "pro" | "team";
export type BillingInterval = "month" | "year";

const Limits = z.object({
  products: z.number().int().min(0), // active products per workspace
  buildsPerMonth: z.number().int().min(0), // engineering runs (one per task attempt chain)
  aiBudgetUsdPerMonth: z.number().min(0), // model spend cap (estimated from provider token usage)
  concurrentBuilds: z.number().int().min(1),
  sandboxMinutesPerMonth: z.number().min(0),
  seats: z.number().int().min(1),
  deploysPerMonth: z.number().int().min(0),
  storageMb: z.number().min(0), // repositories + retained run output
  retentionDays: z.number().int().min(1), // max artifact/log retention a workspace may configure
  githubConnections: z.number().int().min(0),
});
const Features = z.object({
  githubIntegration: z.boolean(),
  pullRequests: z.boolean(),
  deploymentRequests: z.boolean(),
  productionDeploys: z.boolean(),
  advancedAgents: z.boolean(), // engineering lab, evaluations, autonomous goals
  prioritySupport: z.boolean(),
});
const PlanSchema = z.object({
  id: z.enum(["free", "pro", "team"]),
  name: z.string().min(1),
  tagline: z.string(),
  /** Monthly price in USD shown on the pricing page (null = free). */
  priceUsd: z.number().nullable(),
  /** Annual price in USD (null = not offered annually). */
  priceUsdYear: z.number().nullable().default(null),
  /** Env var holding the Stripe price id for monthly checkout (paid plans). */
  stripePriceEnv: z.string().optional(),
  stripePriceEnvYear: z.string().optional(),
  limits: Limits,
  features: Features,
  highlights: z.array(z.string()),
});
const Catalogue = z.object({ plans: z.array(PlanSchema).length(3) });

export type Plan = z.infer<typeof PlanSchema>;
export type LimitKey = keyof Plan["limits"];
export type FeatureKey = keyof Plan["features"];

function load(): Record<PlanId, Plan> {
  let raw: unknown = defaults;
  const file = typeof process !== "undefined" ? process.env?.AURA_PLANS_FILE : undefined;
  if (file) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      console.error(JSON.stringify({ level: "error", event: "plans.load_failed", file, error: (e as Error).message }));
      raw = defaults;
    }
  }
  let parsed = Catalogue.safeParse(raw);
  if (!parsed.success) {
    console.error(JSON.stringify({ level: "error", event: "plans.invalid", error: parsed.error.message.slice(0, 500) }));
    parsed = Catalogue.safeParse(defaults);
  }
  const out = Object.fromEntries(parsed.data!.plans.map((p) => [p.id, p])) as Record<PlanId, Plan>;
  if (!out.free || !out.pro || !out.team) throw new Error("plan catalogue must define free, pro and team");
  return out;
}

export const PLANS: Record<PlanId, Plan> = load();

export const PLAN_ORDER: PlanId[] = ["free", "pro", "team"];

export function planOf(id: string | null | undefined): Plan {
  return PLANS[(id as PlanId) in PLANS ? (id as PlanId) : "free"];
}

/** Statuses that grant the plan's entitlements. past_due keeps access during the provider's retry window. */
export const ENTITLED_STATUSES = ["active", "trialing", "past_due"];

export function priceEnvFor(plan: Plan, interval: BillingInterval) {
  return interval === "year" ? plan.stripePriceEnvYear : plan.stripePriceEnv;
}

/** Explain which current usage would exceed a lower plan's limits (downgrade guard). */
export function downgradeBlockers(target: Plan, usage: { products: number; seats: number; githubConnections: number }) {
  const out: string[] = [];
  if (usage.products > target.limits.products) out.push(`${usage.products} active products (the ${target.name} plan allows ${target.limits.products}) — archive or cancel some first`);
  if (usage.seats > target.limits.seats) out.push(`${usage.seats} seats in use (the ${target.name} plan allows ${target.limits.seats}) — remove members or revoke invitations first`);
  if (usage.githubConnections > target.limits.githubConnections) out.push(`${usage.githubConnections} GitHub connections (the ${target.name} plan allows ${target.limits.githubConnections})`);
  return out;
}
