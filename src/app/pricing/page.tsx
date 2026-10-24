import { SiteHeader, SiteFooter } from "@/components/marketing/site-chrome";
import { PricingCards } from "@/components/marketing/pricing-cards";
import { PLANS, PLAN_ORDER } from "@/lib/billing/plans";

export const metadata = { title: "Pricing — AURA" };

const ROWS: [string, (id: keyof typeof PLANS) => string][] = [
  ["Active products", (id) => String(PLANS[id].limits.products)],
  ["Engineering runs / month", (id) => String(PLANS[id].limits.buildsPerMonth)],
  ["AI usage included / month", (id) => `$${PLANS[id].limits.aiBudgetUsdPerMonth}`],
  ["Sandbox minutes / month", (id) => String(PLANS[id].limits.sandboxMinutesPerMonth)],
  ["Runs at the same time", (id) => String(PLANS[id].limits.concurrentBuilds)],
  ["Seats", (id) => String(PLANS[id].limits.seats)],
  ["Deployments / month", (id) => (PLANS[id].limits.deploysPerMonth ? String(PLANS[id].limits.deploysPerMonth) : "—")],
  ["Production deployments (approval-gated)", (id) => (PLANS[id].features.productionDeploys ? "Yes" : "—")],
  ["Run output retention (max)", (id) => `${PLANS[id].limits.retentionDays} days`],
  ["Engineering lab and autonomous goals", (id) => (PLANS[id].features.advancedAgents ? "Yes" : "—")],
  ["GitHub integration and pull requests", (id) => (PLANS[id].features.pullRequests ? "Yes" : "—")],
  ["Priority support", (id) => (PLANS[id].features.prioritySupport ? "Yes" : "—")],
];

export default function Pricing() {
  return (
    <div className="min-h-screen bg-[#0b0b0d]">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-5 py-16">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Pricing</h1>
        <p className="mt-3 max-w-2xl text-text-muted">Monthly or annual plans, billed through Stripe. Upgrades are prorated. Change or cancel any time from Settings. Usage limits reset on the first of each month.</p>
        <PricingCards />
        <div className="mt-14 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b border-white/10 text-text-faint"><th className="py-2 font-normal">Compare plans</th>{PLAN_ORDER.map((id) => <th key={id} className="py-2 font-medium text-text">{PLANS[id].name}</th>)}</tr></thead>
            <tbody>{ROWS.map(([label, f]) => <tr key={label} className="border-b border-white/5"><td className="py-2.5 text-text-muted">{label}</td>{PLAN_ORDER.map((id) => <td key={id} className="py-2.5">{f(id)}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <p className="mt-6 text-xs text-text-faint">AI usage is measured from the model provider&apos;s reported token usage at list prices. Runs stop safely when a monthly limit is reached; nothing is charged beyond your plan.</p>
      </main>
      <SiteFooter />
    </div>
  );
}
