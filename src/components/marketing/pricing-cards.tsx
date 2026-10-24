import Link from "next/link";
import { Check } from "lucide-react";
import { PLANS, PLAN_ORDER } from "@/lib/billing/plans";

/** Plan cards rendered from the single plan catalogue (src/lib/billing/plans.ts). */
export function PricingCards() {
  return (
    <div className="mt-10 grid gap-4 md:grid-cols-3" data-testid="pricing">
      {PLAN_ORDER.map((id) => {
        const p = PLANS[id];
        const featured = id === "pro";
        return (
          <div key={id} className={`flex flex-col rounded-xl border p-6 ${featured ? "border-brand/40 bg-brand/[0.04]" : "border-white/10"}`}>
            <div className="font-medium">{p.name}</div>
            <p className="mt-1 text-sm text-text-muted">{p.tagline}</p>
            <div className="mt-5 text-3xl font-semibold">{p.priceUsd === null ? "Free" : `$${p.priceUsd}`}<span className="text-sm font-normal text-text-faint">{p.priceUsd === null ? "" : " / month"}</span></div>
            <ul className="mt-5 flex-1 space-y-2 text-sm">
              {p.highlights.map((h) => <li key={h} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" />{h}</li>)}
              <li className="flex gap-2 text-text-muted"><Check className="mt-0.5 h-4 w-4 shrink-0 text-text-faint" />${p.limits.aiBudgetUsdPerMonth} AI usage / month included</li>
            </ul>
            <Link href={`/register${id === "free" ? "" : `?plan=${id}`}`} className={`${featured ? "btn-primary" : "btn-secondary"} mt-6 h-10`}>{id === "free" ? "Start free" : `Choose ${p.name}`}</Link>
          </div>
        );
      })}
    </div>
  );
}
