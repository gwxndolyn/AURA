import { ok } from "@/lib/api";
import { PLANS, PLAN_ORDER } from "@/lib/billing/plans";
import { billingConfigured } from "@/lib/billing/stripe";

export const dynamic = "force-dynamic";

/** Public plan catalogue for the pricing page (no secrets; checkout availability only). */
export async function GET() {
  const b = billingConfigured();
  return ok({ plans: PLAN_ORDER.map((id) => { const p = PLANS[id]; return { id, name: p.name, tagline: p.tagline, priceUsd: p.priceUsd, limits: p.limits, features: p.features, highlights: p.highlights }; }), checkoutAvailable: b.configured });
}
