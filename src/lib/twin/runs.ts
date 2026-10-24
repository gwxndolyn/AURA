/**
 * Simulation runs: persist, reproduce, what-if, compare, review.
 *
 * A run stores everything needed to reproduce it: scenario, rules version,
 * seed, decisions, full initial state, transitions and result, plus hashes.
 * Running the same inputs again must produce the same resultHash (tested).
 * What-if runs copy the BASELINE's initial state — they never read or write
 * live missions, deployments, agents or tools.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { parseJSON } from "@/lib/utils";
import { emitEvent, audit } from "@/lib/events/emit";
import { simulate, validateDecisions, RULES_VERSION, type Decisions, type ScenarioState, type SimResult, type Transition } from "./engine";
import { scenarioById } from "./scenarios";

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const MAX_RUNS_PER_HOUR = 60;

export function inputHash(scenario: string, seed: number, decisions: Decisions, initial: ScenarioState) {
  return sha(canon({ scenario, rulesVersion: RULES_VERSION, seed, decisions, initial }));
}

async function rateLimit(companyId: string) {
  const n = await prisma.twinRun.count({ where: { companyId, createdAt: { gte: new Date(Date.now() - 3600_000) } } });
  if (n >= MAX_RUNS_PER_HOUR) throw new ApiError(`Simulation limit reached (${MAX_RUNS_PER_HOUR} runs/hour)`, 429);
}

export async function runScenario(input: { companyId: string; scenario: string; decisions: Decisions; kind: "baseline" | "what_if"; baselineId?: string; label?: string; seed?: number; actor: string }) {
  const sc = scenarioById(input.scenario);
  if (!sc) throw new ApiError(`Unknown scenario ${input.scenario}`, 422);
  const errs = validateDecisions(input.decisions);
  if (errs.length) throw new ApiError(errs.join("; "), 422);
  await rateLimit(input.companyId);

  let initial: ScenarioState = sc.initial;
  let seed = input.seed ?? sc.seed;
  if (input.kind === "what_if") {
    if (!input.baselineId) throw new ApiError("A what-if needs a baseline run", 422);
    const base = await prisma.twinRun.findFirst({ where: { id: input.baselineId, companyId: input.companyId } });
    if (!base) throw new ApiError("Baseline run not found", 404);
    if (base.scenario !== sc.id) throw new ApiError("Baseline is from a different scenario", 422);
    initial = parseJSON<ScenarioState>(base.initialState, sc.initial); // isolated copy of the baseline's state
    seed = base.seed; // same randomness → differences come from decisions only
  }

  const started = Date.now();
  const { transitions, result } = simulate(initial, input.decisions, seed);
  const criteria = sc.successCriteria.map((c) => ({ id: c.id, text: c.text, met: c.check(result.metrics, result.items) }));
  const resultJson = canon({ ...result, criteria });
  const run = await prisma.twinRun.create({
    data: {
      companyId: input.companyId,
      scenario: sc.id,
      kind: input.kind,
      baselineId: input.baselineId ?? null,
      label: (input.label ?? (input.kind === "baseline" ? "Baseline" : "What-if")).slice(0, 80),
      rulesVersion: RULES_VERSION,
      seed,
      inputs: canon(input.decisions),
      initialState: canon(initial),
      transitions: JSON.stringify(transitions),
      result: resultJson,
      inputHash: inputHash(sc.id, seed, input.decisions, initial),
      resultHash: sha(resultJson),
      durationMs: Date.now() - started,
      createdBy: input.actor,
    },
  });
  // Clearly labelled SIMULATION event (source "twin"), never confused with operational events.
  await emitEvent({ companyId: input.companyId, type: "COMPANY_UPDATED", actor: "system", level: "info", message: `[SIMULATION] ${sc.title} ${input.kind === "baseline" ? "baseline" : "what-if"} run: ${criteria.filter((c) => c.met).length}/${criteria.length} criteria met`, meta: { twinRunId: run.id, simulated: true }, ops: { severity: "info", source: "ops", resourceType: "simulation", resourceId: run.id } });
  return run;
}

export function decodeRun(r: NonNullable<Awaited<ReturnType<typeof prisma.twinRun.findFirst>>>) {
  return {
    ...r,
    inputs: parseJSON<Decisions>(r.inputs, {} as Decisions),
    initialState: parseJSON<ScenarioState>(r.initialState, {} as ScenarioState),
    transitions: parseJSON<Transition[]>(r.transitions, []),
    result: parseJSON<SimResult & { criteria: { id: string; text: string; met: boolean }[] }>(r.result, {} as never),
  };
}

/** Re-run a stored run from its own inputs and confirm the result hash matches. */
export async function verifyReproducible(companyId: string, runId: string) {
  const r = await prisma.twinRun.findFirst({ where: { id: runId, companyId } });
  if (!r) throw new ApiError("Run not found", 404);
  if (r.rulesVersion !== RULES_VERSION) return { reproducible: null, reason: `stored with ${r.rulesVersion}; engine is ${RULES_VERSION}` };
  const sc = scenarioById(r.scenario)!;
  const d = parseJSON<Decisions>(r.inputs, {} as Decisions);
  const initial = parseJSON<ScenarioState>(r.initialState, sc.initial);
  const { result } = simulate(initial, d, r.seed);
  const criteria = sc.successCriteria.map((c) => ({ id: c.id, text: c.text, met: c.check(result.metrics, result.items) }));
  const again = sha(canon({ ...result, criteria }));
  return { reproducible: again === r.resultHash, inputHash: inputHash(r.scenario, r.seed, d, initial) === r.inputHash, resultHash: r.resultHash, recomputed: again };
}

const METRIC_LABEL: Record<string, string> = {
  delivered: "Items delivered (verified)",
  deliveredValue: "Delivered value",
  onTime: "On-time deadline items",
  escapedUnverified: "Shipped unverified",
  verificationCoverage: "Verification coverage",
  avgWaitTicks: "Average wait (days)",
  budgetUsed: "Budget used ($)",
  budgetRemaining: "Budget remaining ($)",
  riskExposure: "Risk exposure (points)",
  incidentDowntime: "Incident downtime (days)",
  slotUtilization: "Slot utilization",
};

/**
 * Compare runs of the same scenario: decision diffs, metric deltas and
 * evidence-based explanations derived from each run's transitions.
 */
export async function compareRuns(companyId: string, ids: string[]) {
  if (ids.length < 2 || ids.length > 4) throw new ApiError("Compare 2–4 runs", 422);
  const rows = await prisma.twinRun.findMany({ where: { id: { in: ids }, companyId } });
  if (rows.length !== ids.length) throw new ApiError("Run not found", 404);
  const runs = ids.map((id) => decodeRun(rows.find((r) => r.id === id)!));
  if (new Set(runs.map((r) => r.scenario)).size > 1) throw new ApiError("Runs must be from the same scenario", 422);
  const [base, ...others] = runs;

  const decisionDiffs = others.map((o) => {
    const diffs: string[] = [];
    const a = base.inputs, b = o.inputs;
    for (const k of ["feature", "quality", "reliability", "security"] as const) if (a.allocation[k] !== b.allocation[k]) diffs.push(`${k} allocation ${Math.round(a.allocation[k] * 100)}% → ${Math.round(b.allocation[k] * 100)}%`);
    if (canon(a.priorities) !== canon(b.priorities)) diffs.push(`priorities ${a.priorities.join(" > ")} → ${b.priorities.join(" > ")}`);
    for (const dept of ["engineering", "qa", "infra", "security"] as const) {
      const x = a.capacity?.[dept] ?? base.initialState.capacity[dept], y = b.capacity?.[dept] ?? o.initialState.capacity[dept];
      if (x !== y) diffs.push(`${dept} capacity ${x} → ${y} slots`);
    }
    if (a.verificationGate !== b.verificationGate) diffs.push(`verification gate ${a.verificationGate ? "on" : "off"} → ${b.verificationGate ? "on" : "off"}`);
    if (a.riskPolicy !== b.riskPolicy) diffs.push(`risk policy ${a.riskPolicy} → ${b.riskPolicy}`);
    if (!!a.useRollback !== !!b.useRollback) diffs.push(`rollback ${a.useRollback ? "used" : "not used"} → ${b.useRollback ? "used" : "not used"}`);
    return { runId: o.id, diffs };
  });

  const metricKeys = Object.keys(METRIC_LABEL) as (keyof SimResult["metrics"])[];
  const table = metricKeys.map((k) => ({ key: k, label: METRIC_LABEL[k], values: runs.map((r) => r.result.metrics[k] ?? null) }));

  // Explanations: per item, when it finished and why it differed (from transitions).
  const explain = others.map((o) => {
    const notes: string[] = [];
    for (const it of base.result.items) {
      const ot = o.result.items.find((x) => x.id === it.id)!;
      if (it.status !== ot.status || it.doneAt !== ot.doneAt || it.verified !== ot.verified) {
        const why = (run: typeof base, id: string) => {
          const tr = run.transitions.filter((x) => x.item === id);
          const waits = tr.filter((x) => x.type === "blocked" || x.type === "approval_wait").map((x) => `day ${x.t}: ${x.detail}`);
          const fails = tr.filter((x) => x.type === "verify_fail").map((x) => `day ${x.t}: ${x.detail}`);
          return [...waits.slice(0, 2), ...fails.slice(0, 2)].join("; ") || "no blocking or rework";
        };
        notes.push(`${it.id}: ${it.status}${it.doneAt ? ` day ${it.doneAt}` : ""}${it.verified ? " verified" : ""} → ${ot.status}${ot.doneAt ? ` day ${ot.doneAt}` : ""}${ot.verified ? " verified" : ""}. Baseline: ${why(base, it.id)}. This run: ${why(o, it.id)}.`);
      }
    }
    const reworkA = base.transitions.filter((x) => x.type === "verify_fail").length, reworkB = o.transitions.filter((x) => x.type === "verify_fail").length;
    if (reworkA !== reworkB) notes.push(`QA rework ${reworkA} → ${reworkB} (defect probability falls with quality allocation; rule: base × (1 − 1.5 × quality share), min 5%).`);
    const incA = base.result.metrics.incidentDowntime, incB = o.result.metrics.incidentDowntime;
    if (incA !== incB) notes.push(`Incident downtime ${incA} → ${incB} days (mitigation speed scales with infra slots and reliability allocation; rollback cuts mitigation effort to a third).`);
    return { runId: o.id, notes: notes.length ? notes : ["No item finished differently; differences are only in cost or utilization."] };
  });

  return {
    scenario: base.scenario,
    rulesVersion: [...new Set(runs.map((r) => r.rulesVersion))],
    runs: runs.map((r) => ({ id: r.id, label: r.label, kind: r.kind, seed: r.seed, inputs: r.inputs, criteria: r.result.criteria, composite: r.result.composite, createdAt: r.createdAt, saved: r.saved })),
    decisionDiffs,
    metrics: table,
    explanations: explain,
    caveat: "Simulated results from documented rules over synthetic work items. They are not a forecast of real delivery.",
  };
}

/** Post-scenario review: why the outcome occurred, from the run's own transitions. */
export function reviewRun(run: ReturnType<typeof decodeRun>) {
  const lines: string[] = [];
  const tr = run.transitions;
  for (const c of run.result.criteria) lines.push(`${c.met ? "Met" : "Not met"}: ${c.text}.`);
  const blocked = tr.filter((x) => x.type === "blocked");
  if (blocked.length) lines.push(`Blocking: ${[...new Set(blocked.map((b) => `${b.item} (${b.detail})`))].slice(0, 4).join("; ")}.`);
  const fails = tr.filter((x) => x.type === "verify_fail");
  if (fails.length) lines.push(`QA rework ${fails.length}×: ${fails.slice(0, 3).map((f) => `day ${f.t} ${f.item}`).join(", ")}.`);
  const missed = tr.filter((x) => x.type === "deadline_missed");
  if (missed.length) lines.push(`Missed deadlines: ${missed.map((m) => `${m.item} (day ${m.t})`).join(", ")}.`);
  const esc = tr.filter((x) => x.type === "escaped");
  if (esc.length) lines.push(`${esc.length} item(s) shipped without verification because the gate was off; they do not count as delivered.`);
  if (tr.some((x) => x.type === "budget_exhausted")) lines.push("The simulated budget ran out before all work finished.");
  const appr = tr.filter((x) => x.type === "approval_wait");
  if (appr.length) lines.push(`Simulated approvals delayed ${appr.length} security item(s) under the ${run.inputs.riskPolicy} policy.`);
  lines.push(`Utilization ${Math.round(run.result.metrics.slotUtilization * 100)}% of available slot-days; $${run.result.metrics.budgetUsed.toLocaleString()} of budget used.`);
  return lines;
}

export async function saveRun(companyId: string, runId: string, actor: string, label?: string) {
  const r = await prisma.twinRun.findFirst({ where: { id: runId, companyId } });
  if (!r) throw new ApiError("Run not found", 404);
  await prisma.twinRun.update({ where: { id: r.id }, data: { saved: true, label: (label ?? r.label).slice(0, 80) } });
  await audit(companyId, actor, "TWIN_RUN_SAVED", r.id, label ?? r.label);
  return { saved: true };
}

/** Discard unsaved runs of one scenario for this workspace only (never touches other data). */
export async function discardUnsaved(companyId: string, scenario: string, actor: string) {
  const res = await prisma.twinRun.deleteMany({ where: { companyId, scenario, saved: false } });
  await audit(companyId, actor, "TWIN_RUNS_DISCARDED", scenario, `${res.count} unsaved run(s)`);
  return { deleted: res.count };
}
