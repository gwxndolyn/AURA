/**
 * Plan catalogue — the single source of truth for pricing, limits and
 * entitlements. The Stripe price for each paid plan comes from the server env
 * (STRIPE_PRICE_<PLAN>); display prices here must match what is configured in
 * Stripe. Nothing else in the codebase hardcodes a limit.
 */

export type PlanId = "free" | "pro" | "team";

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** Monthly price in USD shown on the pricing page (null = free). */
  priceUsd: number | null;
  /** Env var holding the Stripe price id for checkout (paid plans). */
  stripePriceEnv?: string;
  limits: {
    products: number; // active products per workspace
    buildsPerMonth: number; // engineering runs (one per task attempt chain)
    aiBudgetUsdPerMonth: number; // model spend cap (estimated from provider token usage)
    concurrentBuilds: number;
    sandboxMinutesPerMonth: number;
    seats: number;
  };
  features: {
    githubIntegration: boolean;
    pullRequests: boolean;
    deploymentRequests: boolean;
    prioritySupport: boolean;
  };
  highlights: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Starter",
    tagline: "Try the full workflow on a small project.",
    priceUsd: null,
    limits: { products: 1, buildsPerMonth: 10, aiBudgetUsdPerMonth: 3, concurrentBuilds: 1, sandboxMinutesPerMonth: 60, seats: 1 },
    features: { githubIntegration: false, pullRequests: false, deploymentRequests: false, prioritySupport: false },
    highlights: ["1 product", "10 engineering runs / month", "Isolated execution sandbox", "Download your source code"],
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "For builders shipping real projects.",
    priceUsd: 49,
    stripePriceEnv: "STRIPE_PRICE_PRO",
    limits: { products: 10, buildsPerMonth: 150, aiBudgetUsdPerMonth: 60, concurrentBuilds: 2, sandboxMinutesPerMonth: 1200, seats: 3 },
    features: { githubIntegration: true, pullRequests: true, deploymentRequests: true, prioritySupport: false },
    highlights: ["10 products", "150 engineering runs / month", "GitHub branches and pull requests", "Up to 3 teammates"],
  },
  team: {
    id: "team",
    name: "Team",
    tagline: "Shared workspaces with higher limits.",
    priceUsd: 199,
    stripePriceEnv: "STRIPE_PRICE_TEAM",
    limits: { products: 50, buildsPerMonth: 800, aiBudgetUsdPerMonth: 300, concurrentBuilds: 4, sandboxMinutesPerMonth: 6000, seats: 15 },
    features: { githubIntegration: true, pullRequests: true, deploymentRequests: true, prioritySupport: true },
    highlights: ["50 products", "800 engineering runs / month", "Up to 15 teammates", "Priority support"],
  },
};

export const PLAN_ORDER: PlanId[] = ["free", "pro", "team"];

export function planOf(id: string | null | undefined): Plan {
  return PLANS[(id as PlanId) in PLANS ? (id as PlanId) : "free"];
}

/** Statuses that grant the plan's entitlements. past_due keeps access during the provider's retry window. */
export const ENTITLED_STATUSES = ["active", "trialing", "past_due"];
