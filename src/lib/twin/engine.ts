/**
 * Deterministic company simulation engine. PURE: no database, no clock, no
 * network. Given (scenario initial state, decisions, seed, rules version) it
 * always produces the same transitions and result.
 *
 * Model (rules v1) — discrete time, one tick = one simulated working day:
 *   - Work items (synthetic) have a kind (feature | reliability | security |
 *     cost), effort in agent-days, optional dependencies, a value and an
 *     optional deadline. They flow: queued → building (engineering) →
 *     verifying (QA) → done, or → escaped (shipped without verification when
 *     the verification gate is off).
 *   - Capacity: each department has agent-slots (`capacity`). Effective
 *     engineering throughput per slot is 1 agent-day/tick, modified by budget
 *     allocation (see `throughput`). QA verifies `qaSlots × qaRate` effort/tick.
 *   - Scheduling: each tick, eligible items (dependencies done) are ordered by
 *     priority score = value × kind weight (from the CEO's priority order) ×
 *     deadline urgency; ties broken by id. Slots go to the top items.
 *   - QA: verification finds a defect with probability `defectRate(kind)`
 *     reduced by quality allocation (seeded RNG); a defect sends the item back
 *     to building for `reworkFraction` of its effort.
 *   - Incidents (scenario B): a service outage removes engineering capacity
 *     and blocks dependent items until mitigated; mitigation needs
 *     reliability work. Rollback (if allowed) restores in fewer ticks.
 *   - Security exposure (scenario C): each tick an open security item costs
 *     `exposurePerTick` risk points; risk policy decides whether security
 *     items need a simulated approval (adds `approvalDelay` ticks).
 *   - Budget: every USED agent-slot-day (build or QA) costs `costPerSlotTick`;
 *     idle slots are free. No new work starts once the budget is exhausted.
 *
 * Nothing here touches real missions, deployments, agents or tools.
 */
import { seededRandom } from "@/lib/utils";

export const RULES_VERSION = "twin-rules-v1";

export type Kind = "feature" | "reliability" | "security" | "cost";
export type Dept = "engineering" | "qa" | "infra" | "security";
export type Priority = "ship_feature" | "fix_reliability" | "resolve_security" | "reduce_cost";
export type RiskPolicy = "cautious" | "balanced" | "aggressive";

export interface WorkItem {
  id: string;
  title: string;
  kind: Kind;
  effort: number; // agent-days to build
  value: number; // business value points if delivered
  deadline?: number; // tick by which it must be done to count as on-time
  dependsOn?: string[];
  blockedUntil?: number; // external blocker resolves at this tick
  needsService?: string; // depends on a (synthetic) service that may be down
  dept?: Dept; // who builds it (default engineering; security items → security)
}

export interface Incident {
  id: string;
  service: string;
  startsAt: number;
  mitigationEffort: number; // reliability agent-days to mitigate
  rollbackAvailable: boolean;
  capacityLoss: number; // engineering slots lost while active
}

export interface ScenarioState {
  horizon: number; // ticks
  budgetUsd: number;
  costPerSlotTick: number;
  capacity: Record<Dept, number>; // agent-slots
  qaRate: number; // effort points verified per QA slot per tick
  items: WorkItem[];
  incidents: Incident[];
  exposurePerTick: number; // risk points per open security item per tick
  approvalDelay: number; // ticks added when a simulated approval is required
}

export interface Decisions {
  allocation: { feature: number; quality: number; reliability: number; security: number }; // fractions, sum 1
  priorities: Priority[]; // ordered, most important first
  capacity?: Partial<Record<Dept, number>>; // overrides scenario slots (bounded)
  verificationGate: boolean; // require QA before "done"
  riskPolicy: RiskPolicy;
  useRollback?: boolean; // scenario B
}

export interface Transition {
  t: number;
  type: "started" | "progress" | "built" | "verify_pass" | "verify_fail" | "done" | "escaped" | "blocked" | "unblocked" | "incident_start" | "incident_mitigated" | "rollback" | "approval_wait" | "budget_exhausted" | "deadline_missed";
  item?: string;
  dept?: Dept;
  detail: string;
}

export interface ItemResult {
  id: string;
  title: string;
  kind: Kind;
  status: "done" | "escaped" | "in_progress" | "queued" | "blocked";
  verified: boolean;
  doneAt: number | null;
  onTime: boolean | null;
  waitTicks: number;
  defectsFound: number;
}

export interface SimResult {
  rulesVersion: string;
  seed: number;
  horizon: number;
  items: ItemResult[];
  metrics: {
    delivered: number; // done AND verified (or gate off → escaped counts separately)
    deliveredValue: number;
    onTime: number;
    deadlineItems: number;
    escapedUnverified: number;
    verificationCoverage: number | null; // verified ÷ (verified + escaped)
    avgWaitTicks: number;
    budgetUsed: number;
    budgetRemaining: number;
    riskExposure: number; // accumulated security risk points
    incidentDowntime: number; // ticks with an active incident
    slotUtilization: number; // used slot-ticks ÷ available slot-ticks
  };
  composite: { score: number; components: Record<string, { value: number; weight: number; contribution: number }>; formula: string };
}

export const DEFAULT_DECISIONS: Decisions = {
  allocation: { feature: 0.4, quality: 0.2, reliability: 0.2, security: 0.2 },
  priorities: ["ship_feature", "fix_reliability", "resolve_security", "reduce_cost"],
  verificationGate: true,
  riskPolicy: "balanced",
  useRollback: false,
};

export const CAPACITY_LIMITS: Record<Dept, [number, number]> = { engineering: [1, 8], qa: [0, 6], infra: [0, 4], security: [0, 4] };

/** Validate decisions; returns errors (empty = valid). Exported for the API. */
export function validateDecisions(d: Decisions): string[] {
  const errors: string[] = [];
  const a = d.allocation;
  const parts = [a.feature, a.quality, a.reliability, a.security];
  if (parts.some((x) => typeof x !== "number" || x < 0 || x > 1 || Number.isNaN(x))) errors.push("Each allocation must be between 0 and 1");
  const sum = parts.reduce((n, x) => n + x, 0);
  if (Math.abs(sum - 1) > 0.001) errors.push(`Allocations must sum to 100% (they sum to ${Math.round(sum * 100)}%)`);
  if (a.feature < 0.1) errors.push("Feature allocation must be at least 10% (the company must ship something)");
  const all: Priority[] = ["ship_feature", "fix_reliability", "resolve_security", "reduce_cost"];
  if (d.priorities.length !== 4 || all.some((p) => !d.priorities.includes(p))) errors.push("Priorities must rank all four objectives exactly once");
  for (const [k, v] of Object.entries(d.capacity ?? {})) {
    const lim = CAPACITY_LIMITS[k as Dept];
    if (!lim) errors.push(`Unknown department ${k}`);
    else if (!Number.isInteger(v) || v! < lim[0] || v! > lim[1]) errors.push(`${k} capacity must be an integer between ${lim[0]} and ${lim[1]}`);
  }
  if (!["cautious", "balanced", "aggressive"].includes(d.riskPolicy)) errors.push("Unknown risk policy");
  return errors;
}

const KIND_FOR: Record<Priority, Kind> = { ship_feature: "feature", fix_reliability: "reliability", resolve_security: "security", reduce_cost: "cost" };
const RANK_WEIGHT = [4, 2.5, 1.5, 1];

/** Throughput multiplier for an item from budget allocation (diminishing returns, 0.6…1.4). */
function throughput(kind: Kind, a: Decisions["allocation"]) {
  const share = kind === "feature" ? a.feature : kind === "reliability" ? a.reliability : kind === "security" ? a.security : a.feature;
  return 0.6 + 0.8 * Math.sqrt(Math.min(1, share * 2.5));
}

/** Probability QA finds a defect; quality allocation reduces it. */
function defectRate(kind: Kind, a: Decisions["allocation"]) {
  const base = kind === "security" ? 0.35 : kind === "reliability" ? 0.3 : 0.4;
  return Math.max(0.05, base * (1 - 1.5 * a.quality));
}

export function simulate(initial: ScenarioState, d: Decisions, seed: number): { transitions: Transition[]; result: SimResult } {
  const errs = validateDecisions(d);
  if (errs.length) throw new Error(`Invalid decisions: ${errs.join("; ")}`);
  const rnd = seededRandom(seed);
  const cap: Record<Dept, number> = { ...initial.capacity, ...(d.capacity ?? {}) } as Record<Dept, number>;
  const weight: Record<Kind, number> = Object.fromEntries(d.priorities.map((p, i) => [KIND_FOR[p], RANK_WEIGHT[i]])) as Record<Kind, number>;
  const T: Transition[] = [];
  type S = WorkItem & { remaining: number; built: boolean; verifyLeft: number; status: ItemResult["status"]; verified: boolean; doneAt: number | null; wait: number; defects: number; approvalUntil: number | null; started: boolean };
  const items: S[] = initial.items.map((i) => ({ ...i, remaining: i.effort, built: false, verifyLeft: 0, status: "queued", verified: false, doneAt: null, wait: 0, defects: 0, approvalUntil: null, started: false }));
  const byId = new Map(items.map((i) => [i.id, i]));
  const incidents = initial.incidents.map((x) => ({ ...x, active: false, mitigated: false, left: x.mitigationEffort, rolledBack: false }));
  let spent = 0;
  let usedSlots = 0;
  let availSlots = 0;
  let risk = 0;
  let downtime = 0;
  let budgetOut = false;

  for (let t = 1; t <= initial.horizon; t++) {
    // Incidents start / continue.
    for (const inc of incidents) {
      if (!inc.active && !inc.mitigated && t === inc.startsAt) {
        inc.active = true;
        T.push({ t, type: "incident_start", dept: "infra", detail: `Synthetic incident on ${inc.service}: −${inc.capacityLoss} engineering slot(s); dependent work blocked` });
        if (d.useRollback && inc.rollbackAvailable) {
          inc.left = Math.ceil(inc.mitigationEffort / 3);
          inc.rolledBack = true;
          T.push({ t, type: "rollback", dept: "infra", detail: `Rollback applied in the isolated scenario: mitigation effort ${inc.mitigationEffort} → ${inc.left}` });
        }
      }
    }
    const activeInc = incidents.filter((x) => x.active);
    if (activeInc.length) downtime++;

    // Infra mitigates incidents first (reliability allocation speeds it up).
    let infraSlots = cap.infra;
    for (const inc of activeInc) {
      const work = Math.min(inc.left, infraSlots * throughput("reliability", d.allocation));
      if (work > 0) {
        inc.left -= work;
        infraSlots = Math.max(0, infraSlots - Math.ceil(work));
        usedSlots += Math.ceil(work);
      }
      if (inc.left <= 1e-9) {
        inc.active = false;
        inc.mitigated = true;
        T.push({ t, type: "incident_mitigated", dept: "infra", detail: `${inc.service} mitigated${inc.rolledBack ? " (via rollback)" : ""}` });
      }
    }
    availSlots += cap.infra;

    const down = new Set(incidents.filter((x) => x.active).map((x) => x.service));
    const lostEng = incidents.filter((x) => x.active).reduce((n, x) => n + x.capacityLoss, 0);

    // Eligibility + blocking.
    const eligible: S[] = [];
    for (const it of items) {
      if (it.status === "done" || it.status === "escaped") continue;
      const depsDone = (it.dependsOn ?? []).every((dep) => ["done", "escaped"].includes(byId.get(dep)!.status));
      const externallyBlocked = it.blockedUntil !== undefined && t < it.blockedUntil;
      const serviceDown = it.needsService !== undefined && down.has(it.needsService);
      if (!depsDone || externallyBlocked || serviceDown) {
        if (it.status !== "blocked") T.push({ t, type: "blocked", item: it.id, detail: !depsDone ? `waiting on ${(it.dependsOn ?? []).filter((x) => !["done", "escaped"].includes(byId.get(x)!.status)).join(", ")}` : serviceDown ? `${it.needsService} is down` : "external dependency not ready" });
        it.status = "blocked";
        it.wait++;
        continue;
      }
      if (it.status === "blocked") {
        it.status = it.started ? "in_progress" : "queued";
        T.push({ t, type: "unblocked", item: it.id, detail: "dependency satisfied" });
      }
      // Simulated approval for security work depends on risk policy (never real approvals).
      if (it.kind === "security" && !it.started && it.approvalUntil === null) {
        const needs = d.riskPolicy === "cautious" || (d.riskPolicy === "balanced" && it.effort > 3);
        it.approvalUntil = needs ? t + initial.approvalDelay : t;
        if (needs) T.push({ t, type: "approval_wait", item: it.id, detail: `simulated approval required under ${d.riskPolicy} policy (+${initial.approvalDelay} ticks)` });
      }
      if (it.approvalUntil !== null && t < it.approvalUntil) {
        it.wait++;
        continue;
      }
      eligible.push(it);
    }

    // Priority order (deterministic): value × kind weight × urgency.
    const score = (it: S) => it.value * (weight[it.kind] ?? 1) * (it.deadline ? 1 + Math.max(0, 6 - (it.deadline - t)) * 0.25 : 1);
    const toBuild = eligible.filter((i) => !i.built).sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    const toVerify = eligible.filter((i) => i.built && !i.verified).sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));

    // Budget gate: no new slot-ticks once the budget is exhausted.
    const slotCost = initial.costPerSlotTick;
    const affordable = (n: number) => Math.max(0, Math.min(n, Math.floor((initial.budgetUsd - spent) / slotCost)));

    // Build: engineering slots for engineering items; security slots for security items.
    const pools: Record<"engineering" | "security", number> = { engineering: affordable(Math.max(0, cap.engineering - lostEng)), security: 0 };
    pools.security = affordable(cap.security);
    availSlots += cap.engineering + cap.security + cap.qa;
    for (const it of toBuild) {
      const pool = it.dept === "security" || it.kind === "security" ? "security" : "engineering";
      const usePool = pools[pool] > 0 ? pool : pools.engineering > 0 ? "engineering" : null; // engineers can pick up security work
      if (!usePool) {
        it.wait++;
        continue;
      }
      pools[usePool]--;
      usedSlots++;
      spent += slotCost;
      if (!it.started) {
        it.started = true;
        it.status = "in_progress";
        T.push({ t, type: "started", item: it.id, dept: usePool, detail: `${it.title} started` });
      }
      it.remaining -= throughput(it.kind, d.allocation);
      if (it.remaining <= 1e-9) {
        it.built = true;
        it.verifyLeft = it.effort;
        T.push({ t, type: "built", item: it.id, dept: usePool, detail: `${it.title} built` });
        if (!d.verificationGate) {
          it.status = "escaped";
          it.doneAt = t;
          T.push({ t, type: "escaped", item: it.id, detail: "shipped WITHOUT verification (gate off)" });
        }
      }
    }
    // Waiting for build slots counts as waiting.
    for (const it of toBuild) if (!it.started) it.wait++;

    // Verify (QA slots).
    if (d.verificationGate) {
      // Like build slots, QA slots are charged only for the slot-days actually used.
      const qaCapacity = affordable(cap.qa) * initial.qaRate;
      let qa = qaCapacity;
      for (const it of toVerify) {
        if (qa <= 0) {
          it.wait++;
          continue;
        }
        const take = Math.min(qa, it.verifyLeft);
        qa -= take;
        it.verifyLeft -= take;
        if (it.verifyLeft <= 1e-9) {
          if (rnd() < defectRate(it.kind, d.allocation)) {
            it.defects++;
            it.built = false;
            it.remaining = Math.max(0.5, it.effort * 0.4);
            T.push({ t, type: "verify_fail", item: it.id, dept: "qa", detail: `QA found a defect in ${it.title}; rework ${it.remaining.toFixed(1)} agent-days` });
          } else {
            it.verified = true;
            it.status = "done";
            it.doneAt = t;
            T.push({ t, type: "verify_pass", item: it.id, dept: "qa", detail: `${it.title} verified` });
            T.push({ t, type: "done", item: it.id, detail: `${it.title} delivered${it.deadline ? (t <= it.deadline ? " on time" : ` late (deadline ${it.deadline})`) : ""}` });
          }
        }
      }
      const qaSlotsUsed = Math.ceil((qaCapacity - qa) / initial.qaRate - 1e-9);
      usedSlots += qaSlotsUsed;
      spent += qaSlotsUsed * slotCost;
    }

    // Deadlines + security exposure.
    for (const it of items) {
      if (it.deadline === t && it.status !== "done" && it.status !== "escaped") T.push({ t, type: "deadline_missed", item: it.id, detail: `${it.title} missed its deadline` });
      if (it.kind === "security" && it.status !== "done") risk += initial.exposurePerTick;
    }
    if (!budgetOut && spent + slotCost > initial.budgetUsd) {
      budgetOut = true;
      T.push({ t, type: "budget_exhausted", detail: `simulated budget exhausted ($${spent.toLocaleString()} of $${initial.budgetUsd.toLocaleString()})` });
    }
  }

  const res: ItemResult[] = items.map((i) => ({ id: i.id, title: i.title, kind: i.kind, status: i.status, verified: i.verified, doneAt: i.doneAt, onTime: i.deadline ? (i.doneAt !== null && i.doneAt <= i.deadline && (i.verified || !d.verificationGate)) : null, waitTicks: i.wait, defectsFound: i.defects }));
  const delivered = res.filter((r) => r.status === "done" && r.verified);
  const escaped = res.filter((r) => r.status === "escaped");
  const deadlineItems = res.filter((r) => r.onTime !== null);
  const metrics: SimResult["metrics"] = {
    delivered: delivered.length,
    deliveredValue: delivered.reduce((n, r) => n + byId.get(r.id)!.value, 0),
    onTime: deadlineItems.filter((r) => r.onTime).length,
    deadlineItems: deadlineItems.length,
    escapedUnverified: escaped.length,
    verificationCoverage: delivered.length + escaped.length ? delivered.length / (delivered.length + escaped.length) : null,
    avgWaitTicks: res.length ? Math.round((res.reduce((n, r) => n + r.waitTicks, 0) / res.length) * 100) / 100 : 0,
    budgetUsed: spent,
    budgetRemaining: initial.budgetUsd - spent,
    riskExposure: Math.round(risk * 100) / 100,
    incidentDowntime: downtime,
    slotUtilization: availSlots ? Math.round((usedSlots / availSlots) * 1000) / 1000 : 0,
  };
  return { transitions: T, result: { rulesVersion: RULES_VERSION, seed, horizon: initial.horizon, items: res, metrics, composite: composite(metrics, initial) } };
}

/**
 * Optional composite score, fully inspectable. Weights are documented; the
 * UI shows every component. It is NOT used to declare a "winner".
 */
export function composite(m: SimResult["metrics"], s: ScenarioState) {
  const totalValue = s.items.reduce((n, i) => n + i.value, 0) || 1;
  const comps = {
    delivered_value: { value: m.deliveredValue / totalValue, weight: 0.35 },
    on_time: { value: m.deadlineItems ? m.onTime / m.deadlineItems : 1, weight: 0.2 },
    verification: { value: m.verificationCoverage ?? 1, weight: 0.2 },
    budget_left: { value: Math.max(0, m.budgetRemaining) / s.budgetUsd, weight: 0.1 },
    low_risk: { value: 1 / (1 + m.riskExposure / 10), weight: 0.1 },
    uptime: { value: 1 - m.incidentDowntime / s.horizon, weight: 0.05 },
  };
  const components = Object.fromEntries(Object.entries(comps).map(([k, c]) => [k, { ...c, value: Math.round(c.value * 1000) / 1000, contribution: Math.round(c.value * c.weight * 1000) / 1000 }]));
  return {
    score: Math.round(Object.values(components).reduce((n, c) => n + c.contribution, 0) * 1000) / 1000,
    components,
    formula: "0.35·delivered value share + 0.20·on-time share + 0.20·verification coverage + 0.10·budget left share + 0.10·1/(1+risk/10) + 0.05·(1 − downtime/horizon)",
  };
}
