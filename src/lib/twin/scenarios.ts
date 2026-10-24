/**
 * Scenario library — documented, reproducible initial conditions. All work
 * items, services and incidents are SYNTHETIC (prefixed SIM-) and never
 * represent the user's real project.
 */
import type { ScenarioState, Decisions } from "./engine";
import { DEFAULT_DECISIONS } from "./engine";

export interface Scenario {
  id: "delivery_crunch" | "reliability_crisis" | "security_growth";
  title: string;
  situation: string[];
  objectives: string[];
  actions: string[];
  constraints: string[];
  successCriteria: { id: string; text: string; check: (m: import("./engine").SimResult["metrics"], items: import("./engine").ItemResult[]) => boolean }[];
  seed: number;
  initial: ScenarioState;
  defaults: Decisions;
}

export const SCENARIOS: Record<Scenario["id"], Scenario> = {
  delivery_crunch: {
    id: "delivery_crunch",
    title: "Delivery Crunch",
    situation: [
      "Five synthetic work items compete for 3 engineering slots and 1 QA slot over a 12-day horizon.",
      "The flagship feature SIM-CHECKOUT-V2 depends on SIM-PAYMENTS-API, which is blocked by an external vendor until day 3.",
      "Two items have deadlines (day 8 and day 10). Budget covers about 60 slot-days.",
    ],
    objectives: ["Deliver SIM-CHECKOUT-V2 verified by its deadline (day 10).", "Keep verification coverage at 100%.", "Stay within budget."],
    actions: ["Reallocate budget between feature, quality, reliability and security.", "Reorder priorities.", "Change engineering/QA slots (1–8 / 0–6).", "Toggle the verification gate (turning it off ships unverified work)."],
    constraints: ["Allocations sum to 100%, feature ≥ 10%.", "Capacity within the documented limits.", "Budget: $60,000 at $1,000 per slot-day."],
    successCriteria: [
      { id: "flagship", text: "SIM-CHECKOUT-V2 delivered and verified by day 10", check: (_m, items) => !!items.find((i) => i.id === "SIM-CHECKOUT-V2" && i.verified && i.onTime) },
      { id: "coverage", text: "100% of delivered work verified", check: (m) => m.escapedUnverified === 0 && m.delivered > 0 },
      { id: "budget", text: "Budget not exceeded", check: (m) => m.budgetRemaining >= 0 },
    ],
    seed: 4242,
    initial: {
      horizon: 12,
      budgetUsd: 60_000,
      costPerSlotTick: 1_000,
      capacity: { engineering: 3, qa: 1, infra: 1, security: 1 },
      qaRate: 2,
      exposurePerTick: 0.5,
      approvalDelay: 2,
      incidents: [],
      items: [
        { id: "SIM-PAYMENTS-API", title: "Payments API v2", kind: "feature", effort: 3, value: 5, blockedUntil: 3 },
        { id: "SIM-CHECKOUT-V2", title: "Checkout v2 (flagship)", kind: "feature", effort: 4, value: 13, deadline: 10, dependsOn: ["SIM-PAYMENTS-API"] },
        { id: "SIM-ONBOARDING", title: "Onboarding refresh", kind: "feature", effort: 3, value: 5, deadline: 8 },
        { id: "SIM-FLAKY-JOBS", title: "Fix flaky background jobs", kind: "reliability", effort: 2, value: 4 },
        { id: "SIM-COST-CACHE", title: "Response caching (cost)", kind: "cost", effort: 2, value: 3 },
      ],
    },
    defaults: { ...DEFAULT_DECISIONS, allocation: { feature: 0.4, quality: 0.2, reliability: 0.2, security: 0.2 }, priorities: ["ship_feature", "fix_reliability", "resolve_security", "reduce_cost"] },
  },
  reliability_crisis: {
    id: "reliability_crisis",
    title: "Reliability Crisis",
    situation: [
      "A synthetic outage hits SIM-ledger-service on day 2, removing 1 engineering slot and blocking two dependent items.",
      "Mitigation needs 6 reliability agent-days; a rollback of the last synthetic release is available in the isolated scenario.",
    ],
    objectives: ["Mitigate the outage quickly.", "Deliver the dependent items within the horizon.", "Keep verification coverage at 100%."],
    actions: ["Increase infra capacity.", "Shift allocation to reliability.", "Use the rollback (scenario-only).", "Reprioritize reliability work."],
    constraints: ["Incident and services are synthetic — no real system is touched.", "Budget $50,000 at $1,000 per slot-day."],
    successCriteria: [
      { id: "mitigate", text: "Outage mitigated within 4 days", check: (m) => m.incidentDowntime <= 4 },
      { id: "dependents", text: "Both dependent items delivered verified", check: (_m, items) => ["SIM-LEDGER-RECON", "SIM-INVOICE-EXPORT"].every((id) => items.find((i) => i.id === id)?.verified) },
      { id: "coverage", text: "100% of delivered work verified", check: (m) => m.escapedUnverified === 0 },
    ],
    seed: 7310,
    initial: {
      horizon: 12,
      budgetUsd: 50_000,
      costPerSlotTick: 1_000,
      capacity: { engineering: 3, qa: 1, infra: 1, security: 0 },
      qaRate: 2,
      exposurePerTick: 0,
      approvalDelay: 2,
      incidents: [{ id: "SIM-INC-1", service: "SIM-ledger-service", startsAt: 2, mitigationEffort: 6, rollbackAvailable: true, capacityLoss: 1 }],
      items: [
        { id: "SIM-LEDGER-RECON", title: "Ledger reconciliation", kind: "feature", effort: 3, value: 8, needsService: "SIM-ledger-service" },
        { id: "SIM-INVOICE-EXPORT", title: "Invoice export", kind: "feature", effort: 2, value: 5, needsService: "SIM-ledger-service" },
        { id: "SIM-ALERTING", title: "Ledger alerting", kind: "reliability", effort: 2, value: 4 },
        { id: "SIM-DASHBOARD", title: "Usage dashboard", kind: "feature", effort: 3, value: 3 },
      ],
    },
    defaults: { ...DEFAULT_DECISIONS, useRollback: false },
  },
  security_growth: {
    id: "security_growth",
    title: "Security vs Growth",
    situation: [
      "A synthetic security finding (SIM-AUTHZ-GAP) competes with two growth features for constrained budget.",
      "Every day the finding stays open adds risk exposure; the cautious policy requires a simulated approval for security work.",
    ],
    objectives: ["Close SIM-AUTHZ-GAP.", "Deliver at least one growth feature.", "Keep risk exposure low."],
    actions: ["Allocate budget to security vs feature.", "Change risk policy (simulated approvals only).", "Reorder priorities.", "Adjust security capacity."],
    constraints: ["The finding is fictional and is NOT a finding in your real project.", "Budget $40,000 at $1,000 per slot-day."],
    successCriteria: [
      { id: "closed", text: "SIM-AUTHZ-GAP fixed and verified", check: (_m, items) => !!items.find((i) => i.id === "SIM-AUTHZ-GAP")?.verified },
      { id: "growth", text: "At least one growth feature delivered verified", check: (_m, items) => items.some((i) => i.kind === "feature" && i.verified) },
      { id: "risk", text: "Risk exposure ≤ 8 points (1 point per day the finding stays open)", check: (m) => m.riskExposure <= 8 },
    ],
    seed: 9157,
    initial: {
      horizon: 10,
      budgetUsd: 40_000,
      costPerSlotTick: 1_000,
      capacity: { engineering: 2, qa: 1, infra: 0, security: 1 },
      qaRate: 2,
      exposurePerTick: 1,
      approvalDelay: 2,
      incidents: [],
      items: [
        { id: "SIM-AUTHZ-GAP", title: "Fix tenant authorization gap (synthetic)", kind: "security", effort: 4, value: 6, dept: "security" },
        { id: "SIM-REFERRALS", title: "Referral programme", kind: "feature", effort: 4, value: 8, deadline: 9 },
        { id: "SIM-PRICING-PAGE", title: "Pricing page experiment", kind: "feature", effort: 2, value: 4 },
      ],
    },
    defaults: { ...DEFAULT_DECISIONS, riskPolicy: "cautious" },
  },
};

export function scenarioById(id: string): Scenario | null {
  return (SCENARIOS as Record<string, Scenario>)[id] ?? null;
}
