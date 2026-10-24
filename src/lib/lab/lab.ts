/**
 * The engineering lab: persisted benchmark runs, experiments on AURA's own
 * engineering methods, and the durable improvement-loop state.
 *
 * Experiment lifecycle (one at a time per workspace — conflicting experiments
 * never share the working configuration):
 *
 *   PROPOSED → RUNNING → ACCEPTED | REJECTED | INCONCLUSIVE | AWAITING_APPROVAL
 *                     ↘ CANCELLED | INTERRUPTED (resumable: rerun from scratch,
 *                       runs are idempotent and cheap)
 *
 * Decision rules (decide()):
 *  - baseline and candidate run the SAME suite version, split and executor
 *  - REJECT if any regression criterion fails, if the candidate introduces a
 *    critical failure (a defective change falsely accepted) on any split, or
 *    if held-out casesPassed drops
 *  - ACCEPT only if every success criterion is met on the stated split and no
 *    rejection rule fired; a change to a security-relevant method then goes
 *    to AWAITING_APPROVAL (an ADMIN applies it), others are ACCEPTED
 *  - otherwise INCONCLUSIVE (kept, never promoted)
 *  - an approach key already REJECTED is not run again unless `force` is
 *    given with a reason (the rejection evidence is returned instead)
 *
 * Accepting an experiment records the configuration as the lab's
 * `activeConfig`; the builder adopts a method only when its code default is
 * changed in a reviewed commit (this file never edits code or env).
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { parseJSON } from "@/lib/utils";
import { audit, emitEvent } from "@/lib/events/emit";
import { log } from "@/lib/observability/log";
import { SUITE_VERSION, suite } from "./benchmarks";
import { resolveConfig } from "./config";
import { chooseExecutor } from "./executor";
import { runBenchmark, type CaseOutcome } from "./runner";
import { scorecard, metricValue, type Scorecard } from "./scorecard";

export interface Rule { metric: string; op: ">=" | "<=" | ">" | "<" | "delta>=" | "delta<="; value: number; split: "train" | "heldout" | "all" }

export const LAB_LIMITS = { maxCases: Number(process.env.AURA_LAB_MAX_CASES || 200), maxRunMs: Number(process.env.AURA_LAB_MAX_RUN_MS || 10 * 60_000) };

async function codeVersion() {
  return process.env.AURA_CODE_VERSION || process.env.VERCEL_GIT_COMMIT_SHA || "unversioned-working-tree";
}

/** Execute a suite under a configuration and persist every case. */
export async function runSuite(args: { companyId: string; configKey: string; split?: "train" | "heldout" | "all"; label?: string; experimentId?: string; actor: string; only?: string[] }) {
  const cfg = resolveConfig(args.configKey);
  const ex = await chooseExecutor();
  const split = args.split ?? "all";
  const cases = suite(split).filter((b) => !args.only || args.only.includes(b.id)).slice(0, LAB_LIMITS.maxCases);
  const run = await prisma.labRun.create({ data: { companyId: args.companyId, suiteVersion: SUITE_VERSION, split, configKey: cfg.key, config: JSON.stringify(cfg), codeVersion: await codeVersion(), executor: ex.kind ?? "none", experimentId: args.experimentId ?? null, label: args.label ?? "adhoc", createdBy: args.actor, total: cases.length } });
  if (!ex.kind) {
    await prisma.labRun.update({ where: { id: run.id }, data: { status: "FAILED", error: ex.reason, finishedAt: new Date(), skipped: cases.length } });
    throw new ApiError(`Benchmarks cannot execute: ${ex.reason}`, 503);
  }
  const started = Date.now();
  const outcomes: CaseOutcome[] = [];
  for (const b of cases) {
    if (Date.now() - started > LAB_LIMITS.maxRunMs) {
      outcomes.push({ benchmarkId: b.id, benchmarkVersion: b.version, category: b.category, split: b.split, kind: b.kind, fixtureHash: "", status: "SKIPPED", criteria: [], measures: {}, commands: [], error: "run time limit reached", durationMs: 0, sandboxMs: 0 });
      continue;
    }
    const fresh = await prisma.labRun.findUnique({ where: { id: run.id }, select: { status: true } });
    if (fresh?.status === "CANCELLED") break;
    const o = await runBenchmark(b, cfg, ex.kind, { companyId: args.companyId });
    outcomes.push(o);
    await prisma.labCaseResult.create({ data: { runId: run.id, benchmarkId: o.benchmarkId, benchmarkVersion: String(o.benchmarkVersion), category: o.category, split: o.split, fixtureHash: o.fixtureHash, status: o.status, criteria: JSON.stringify(o.criteria), measures: JSON.stringify(o.measures), commands: JSON.stringify(o.commands), error: o.error, durationMs: o.durationMs } });
  }
  const card = { all: scorecard(outcomes, "all"), train: scorecard(outcomes, "train"), heldout: scorecard(outcomes, "heldout") };
  const cancelled = (await prisma.labRun.findUnique({ where: { id: run.id }, select: { status: true } }))?.status === "CANCELLED";
  const done = await prisma.labRun.update({
    where: { id: run.id },
    data: { status: cancelled ? "CANCELLED" : "COMPLETED", passed: outcomes.filter((o) => o.status === "PASSED").length, failed: outcomes.filter((o) => o.status === "FAILED").length, errored: outcomes.filter((o) => o.status === "ERROR").length, skipped: outcomes.filter((o) => o.status === "SKIPPED").length, metrics: JSON.stringify(card), durationMs: Date.now() - started, sandboxMs: outcomes.reduce((s, o) => s + o.sandboxMs, 0), finishedAt: new Date() },
  });
  log("info", "lab.run_completed", { runId: run.id, config: cfg.key, split, passed: done.passed, total: done.total, executor: ex.kind });
  return { run: done, outcomes, card };
}

function check(rule: Rule, base: Record<string, Scorecard>, cand: Record<string, Scorecard>) {
  const b = metricValue(base[rule.split], rule.metric);
  const c = metricValue(cand[rule.split], rule.metric);
  if (c === null || (rule.op.startsWith("delta") && b === null)) return { ok: null as boolean | null, b, c };
  const v = rule.op.startsWith("delta") ? c - (b as number) : c;
  const ok = rule.op === ">=" || rule.op === "delta>=" ? v >= rule.value : rule.op === "<=" || rule.op === "delta<=" ? v <= rule.value : rule.op === ">" ? v > rule.value : v < rule.value;
  return { ok, b, c };
}

/** Categories whose pass rate dropped (baseline → candidate), from the scorecards' per-category breakdown. */
export function categoryRegressions(base: Scorecard, cand: Scorecard) {
  const out: string[] = [];
  for (const [cat, b] of Object.entries(base.byCategory ?? {})) {
    const c = cand.byCategory?.[cat];
    if (!c || !b.denominator || !c.denominator) continue;
    if ((c.value ?? 0) < (b.value ?? 0)) out.push(`${cat} ${b.numerator}/${b.denominator} → ${c.numerator}/${c.denominator}`);
  }
  return out;
}

export function decide(input: { success: Rule[]; regression: Rule[]; base: Record<string, Scorecard>; cand: Record<string, Scorecard>; securityRelevant: boolean }) {
  const reasons: string[] = [];
  const fmt = (x: number | null) => (x === null ? "n/a" : Number(x.toFixed(4)).toString());
  const results = {
    success: input.success.map((r) => ({ rule: r, ...check(r, input.base, input.cand) })),
    regression: input.regression.map((r) => ({ rule: r, ...check(r, input.base, input.cand) })),
  };
  let reject = false;
  for (const r of results.regression) if (r.ok === false) { reject = true; reasons.push(`regression: ${r.rule.split} ${r.rule.metric} ${fmt(r.b)} → ${fmt(r.c)} violates ${r.rule.op} ${r.rule.value}`); }
  const newCritical = input.cand.all.criticalFailures.filter((id) => !input.base.all.criticalFailures.includes(id));
  if (newCritical.length) { reject = true; reasons.push(`candidate falsely accepts defective changes it previously rejected: ${newCritical.join(", ")}`); }
  // Per-category quality: a candidate may not regress ANY task category (unrelated categories included), whatever its aggregate.
  for (const reg of categoryRegressions(input.base.all, input.cand.all)) { reject = true; reasons.push(`category regression: ${reg}`); }
  const hb = metricValue(input.base.heldout, "functional.casesPassed"), hc = metricValue(input.cand.heldout, "functional.casesPassed");
  if (hb !== null && hc !== null && hc < hb) { reject = true; reasons.push(`held-out casesPassed dropped ${fmt(hb)} → ${fmt(hc)}`); }
  const unmeasured = [...results.success, ...results.regression].filter((r) => r.ok === null).map((r) => `${r.rule.split} ${r.rule.metric}`);
  if (unmeasured.length) reasons.push(`not measured: ${unmeasured.join(", ")}`);
  const allSuccess = results.success.length > 0 && results.success.every((r) => r.ok === true);
  for (const r of results.success) reasons.push(`success: ${r.rule.split} ${r.rule.metric} ${fmt(r.b)} → ${fmt(r.c)} (${r.rule.op} ${r.rule.value}: ${r.ok === null ? "not measured" : r.ok ? "met" : "not met"})`);
  const outcome = reject ? "REJECTED" : allSuccess ? (input.securityRelevant ? "AWAITING_APPROVAL" : "ACCEPTED") : "INCONCLUSIVE";
  return { outcome, reasons, results };
}

export interface ProposeInput {
  companyId: string; actor: string; key: string; title: string; problem: string; evidence: { kind: string; ref: string; detail: string }[]; hypothesis: string;
  success: Rule[]; regression: Rule[]; procedure: string; rejectIf: string; baselineConfig: string; candidateConfig: string; codeChange?: string; force?: string;
}

export async function proposeExperiment(input: ProposeInput) {
  resolveConfig(input.baselineConfig);
  resolveConfig(input.candidateConfig);
  if (!input.evidence.length) throw new ApiError("An experiment needs evidence that the problem exists", 422);
  if (!input.success.length) throw new ApiError("An experiment needs at least one measurable success criterion", 422);
  const prior = await prisma.labExperiment.findFirst({ where: { companyId: input.companyId, key: input.key, status: "REJECTED" }, orderBy: { createdAt: "desc" } });
  if (prior && !input.force) throw new ApiError(`Approach "${input.key}" was already rejected (${prior.id}): ${parseJSON<{ reasons?: string[] }>(prior.decision, {}).reasons?.slice(0, 2).join("; ")}. Pass force with a reason to re-test it.`, 409);
  const e = await prisma.labExperiment.create({ data: { companyId: input.companyId, key: input.key, title: input.title, problem: input.problem, evidence: JSON.stringify(input.evidence), hypothesis: input.hypothesis, successCriteria: JSON.stringify(input.success), regressionCriteria: JSON.stringify(input.regression), procedure: input.procedure, rejectIf: input.rejectIf, baselineConfig: input.baselineConfig, candidateConfig: input.candidateConfig, codeChange: [input.codeChange ?? "", input.force ? `re-test justification: ${input.force}` : ""].filter(Boolean).join("\n"), createdBy: input.actor } });
  await audit(input.companyId, input.actor, "LAB_EXPERIMENT_PROPOSED", e.id, input.key);
  return e;
}

/**
 * A change is security-relevant when a method that guards what is accepted or
 * executed DIFFERS between the arms (today: the verification gate). Computed
 * from the resolved configurations, not from the experiment's wording.
 */
/** Two config specs resolve to the same methods. */
export function sameConfig(a: string, b: string) {
  const x = resolveConfig(a), y = resolveConfig(b);
  return x.gatePolicy === y.gatePolicy && x.contextStrategy === y.contextStrategy && x.classifier === y.classifier;
}

export function securityRelevantChange(baseline: string, candidate: string) {
  const a = resolveConfig(baseline), b = resolveConfig(candidate);
  return a.gatePolicy !== b.gatePolicy;
}

/** Run baseline and candidate on the same suite/executor, decide, persist, update loop state. */
export async function runExperiment(companyId: string, experimentId: string, actor: string) {
  const e = await prisma.labExperiment.findFirst({ where: { id: experimentId, companyId } });
  if (!e) throw new ApiError("Experiment not found", 404);
  if (!["PROPOSED", "INTERRUPTED"].includes(e.status)) throw new ApiError(`Experiment is ${e.status.toLowerCase()}`, 409);
  const busy = await prisma.labExperiment.findFirst({ where: { companyId, status: "RUNNING", id: { not: e.id } } });
  if (busy) throw new ApiError(`Experiment ${busy.id} is running; experiments never share the working configuration`, 409);
  const claimed = await prisma.labExperiment.updateMany({ where: { id: e.id, status: e.status }, data: { status: "RUNNING" } });
  if (claimed.count !== 1) throw new ApiError("Experiment was started concurrently", 409);
  await saveState(companyId, { status: "RUNNING", activeExperimentId: e.id, nextAction: `finish experiment ${e.key}`, resume: `Experiment ${e.id} was RUNNING. On restart it is marked INTERRUPTED; re-run it (runs are idempotent).` });
  try {
    const base = await runSuite({ companyId, configKey: e.baselineConfig, split: "all", label: "baseline", experimentId: e.id, actor });
    const cand = await runSuite({ companyId, configKey: e.candidateConfig, split: "all", label: "candidate", experimentId: e.id, actor });
    if (base.run.executor !== cand.run.executor) throw new ApiError("Baseline and candidate ran on different executors; not comparable", 500);
    const d = decide({ success: parseJSON<Rule[]>(e.successCriteria, []), regression: parseJSON<Rule[]>(e.regressionCriteria, []), base: base.card, cand: cand.card, securityRelevant: securityRelevantChange(e.baselineConfig, e.candidateConfig) });
    const perCase = base.outcomes.map((o) => ({ id: o.benchmarkId, split: o.split, baseline: o.status, candidate: cand.outcomes.find((c) => c.benchmarkId === o.benchmarkId)?.status ?? "MISSING" })).filter((x) => x.baseline !== x.candidate);
    const updated = await prisma.labExperiment.update({ where: { id: e.id }, data: { status: d.outcome, baselineRunIds: JSON.stringify([base.run.id]), candidateRunIds: JSON.stringify([cand.run.id]), decision: JSON.stringify({ outcome: d.outcome, reasons: d.reasons, changedCases: perCase, baseline: base.card, candidate: cand.card, suiteVersion: SUITE_VERSION, executor: base.run.executor }), finishedAt: new Date() } });
    await audit(companyId, actor, "LAB_EXPERIMENT_DECIDED", e.id, `${e.key}: ${d.outcome}`);
    await emitEvent({ companyId, type: "LAB_EXPERIMENT", level: d.outcome === "ACCEPTED" ? "success" : d.outcome === "REJECTED" ? "warning" : "info", message: `Lab experiment "${e.title}": ${d.outcome.toLowerCase().replace("_", " ")}`, meta: { experimentId: e.id } }).catch(() => null);
    // Adopt only when the experiment started from the configuration currently in force; otherwise an
    // accepted result could carry along methods that were never approved (e.g. a gate still awaiting approval).
    const st = await loadState(companyId);
    // Evidence from host-trusted execution does not transfer to the sandbox (different Node version and
    // environment): lab evidence 2026-10-23, classifier v2 passed on the host and failed in Docker.
    const productionExecutor = base.run.executor === "docker";
    const adoptable = d.outcome === "ACCEPTED" && sameConfig(e.baselineConfig, st.activeConfig) && productionExecutor;
    if (d.outcome === "ACCEPTED" && !productionExecutor) d.reasons.push("accepted on the host-trusted executor only; re-run on the Docker sandbox before adopting");
    if (d.outcome === "ACCEPTED" && !adoptable) d.reasons.push(`accepted, but not adopted: its baseline (${e.baselineConfig}) is not the active configuration (${st.activeConfig}); re-run against the active configuration to adopt it`);
    if (d.outcome === "ACCEPTED") await prisma.labExperiment.update({ where: { id: e.id }, data: { decision: JSON.stringify({ ...parseJSON<Record<string, unknown>>(updated.decision, {}), reasons: d.reasons, adopted: adoptable }) } });
    await saveState(companyId, { status: "IDLE", activeExperimentId: null, ...(adoptable ? { activeConfig: e.candidateConfig } : {}), nextAction: d.outcome === "AWAITING_APPROVAL" ? `an admin decides experiment ${e.key}` : "select the next weakness from the latest scorecard" });
    return { experiment: updated, decision: d, changedCases: perCase };
  } catch (err) {
    await prisma.labExperiment.update({ where: { id: e.id }, data: { status: "INTERRUPTED", decision: JSON.stringify({ outcome: "INTERRUPTED", reasons: [(err as Error).message.slice(0, 500)] }) } });
    await saveState(companyId, { status: "BLOCKED", activeExperimentId: null, blockers: [(err as Error).message.slice(0, 300)] });
    throw err;
  }
}

/** ADMIN decision on an experiment awaiting approval (security-relevant methods). */
export async function approveExperiment(companyId: string, experimentId: string, actor: string, decision: "approve" | "reject", note = "") {
  const r = await prisma.labExperiment.updateMany({ where: { id: experimentId, companyId, status: "AWAITING_APPROVAL" }, data: { status: decision === "approve" ? "ACCEPTED" : "REJECTED", decidedBy: actor } });
  if (r.count !== 1) throw new ApiError("Experiment is not awaiting approval", 409);
  const e = (await prisma.labExperiment.findUnique({ where: { id: experimentId } }))!;
  const d = parseJSON<Record<string, unknown>>(e.decision, {});
  await prisma.labExperiment.update({ where: { id: e.id }, data: { decision: JSON.stringify({ ...d, approval: { by: actor, decision, note, at: new Date().toISOString() } }) } });
  const st = await loadState(companyId);
  const adoptable = decision === "approve" && sameConfig(e.baselineConfig, st.activeConfig);
  if (adoptable) await saveState(companyId, { activeConfig: e.candidateConfig });
  await prisma.labExperiment.update({ where: { id: e.id }, data: { decision: JSON.stringify({ ...parseJSON<Record<string, unknown>>((await prisma.labExperiment.findUnique({ where: { id: e.id } }))!.decision, {}), adopted: adoptable }) } });
  await audit(companyId, actor, "LAB_EXPERIMENT_APPROVAL", e.id, `${decision}${note ? `: ${note}` : ""}`);
  return { status: decision === "approve" ? "ACCEPTED" : "REJECTED" };
}

export async function cancelExperiment(companyId: string, experimentId: string, actor: string) {
  const r = await prisma.labExperiment.updateMany({ where: { id: experimentId, companyId, status: { in: ["PROPOSED", "RUNNING", "INTERRUPTED"] } }, data: { status: "CANCELLED", decidedBy: actor } });
  if (r.count !== 1) throw new ApiError("Experiment cannot be cancelled in its current state", 409);
  await prisma.labRun.updateMany({ where: { experimentId, companyId, status: "RUNNING" }, data: { status: "CANCELLED" } });
  await saveState(companyId, { status: "IDLE", activeExperimentId: null });
  return { status: "CANCELLED" };
}

// ---------------------------------------------------------------------------
// Durable loop state
// ---------------------------------------------------------------------------

export async function loadState(companyId: string) {
  return prisma.labState.upsert({ where: { companyId }, create: { companyId }, update: {} });
}

export async function saveState(companyId: string, patch: Partial<{ objective: string; status: string; activeExperimentId: string | null; activeConfig: string; backlog: unknown[]; blockers: string[]; regressions: unknown[]; nextAction: string; resume: string }>) {
  await loadState(companyId);
  const data: Record<string, unknown> = { ...patch, version: { increment: 1 } };
  for (const k of ["backlog", "blockers", "regressions"] as const) if (patch[k]) data[k] = JSON.stringify(patch[k]);
  return prisma.labState.update({ where: { companyId }, data });
}

/**
 * Startup / resume verification: never trust stale status. Experiments and
 * runs left RUNNING by a dead process are marked INTERRUPTED; the state's
 * active experiment is reconciled with the experiment rows.
 */
export async function verifyState(companyId: string, opts: { staleMs?: number } = {}) {
  const staleMs = opts.staleMs ?? LAB_LIMITS.maxRunMs * 2;
  const cutoff = new Date(Date.now() - staleMs);
  const runs = await prisma.labRun.updateMany({ where: { companyId, status: "RUNNING", startedAt: { lt: cutoff } }, data: { status: "INTERRUPTED", error: "process ended before the run finished", finishedAt: new Date() } });
  const stale = await prisma.labExperiment.findMany({ where: { companyId, status: "RUNNING", createdAt: { lt: cutoff } } });
  for (const e of stale) await prisma.labExperiment.update({ where: { id: e.id }, data: { status: "INTERRUPTED", decision: JSON.stringify({ outcome: "INTERRUPTED", reasons: ["the process ended during the experiment; re-run it"] }) } });
  const st = await loadState(companyId);
  const active = st.activeExperimentId ? await prisma.labExperiment.findFirst({ where: { id: st.activeExperimentId, companyId } }) : null;
  const fixes: string[] = [];
  if (runs.count) fixes.push(`${runs.count} interrupted run(s) marked`);
  if (stale.length) fixes.push(`${stale.length} interrupted experiment(s) marked: ${stale.map((s) => s.key).join(", ")}`);
  let status = st.status;
  if (st.activeExperimentId && (!active || active.status !== "RUNNING")) {
    fixes.push(`state pointed at experiment ${st.activeExperimentId} which is ${active?.status ?? "missing"}`);
    status = st.status === "PAUSED" ? "PAUSED" : "IDLE";
  }
  const state = await prisma.labState.update({ where: { companyId }, data: { lastVerifiedAt: new Date(), ...(fixes.length ? { status, activeExperimentId: active?.status === "RUNNING" ? active.id : null } : {}) } });
  return { state, fixes };
}

export async function setLoopStatus(companyId: string, action: "pause" | "resume", actor: string) {
  const st = await loadState(companyId);
  if (action === "pause") {
    if (st.status === "PAUSED") throw new ApiError("Already paused", 409);
    await saveState(companyId, { status: "PAUSED" });
  } else {
    if (st.status !== "PAUSED") throw new ApiError("Not paused", 409);
    await saveState(companyId, { status: "IDLE" });
  }
  await audit(companyId, actor, "LAB_LOOP", companyId, action);
  return loadState(companyId);
}

/**
 * Evidence-ranked improvement backlog from the latest completed run of the
 * active configuration: failing benchmarks grouped by capability, ordered by
 * risk (critical false-accepts first, then held-out failures, then train).
 */
export async function proposeBacklog(companyId: string) {
  const st = await loadState(companyId);
  const run = await prisma.labRun.findFirst({ where: { companyId, status: "COMPLETED", configKey: st.activeConfig, split: "all" }, orderBy: { startedAt: "desc" }, include: { cases: true } });
  if (!run) return { runId: null, items: [] as BacklogEntry[] };
  const failing = run.cases.filter((c) => c.status !== "PASSED");
  const tried = new Set((await prisma.labExperiment.findMany({ where: { companyId }, select: { key: true, status: true } })).filter((x) => x.status === "REJECTED").map((x) => x.key));
  const groups = new Map<string, typeof failing>();
  for (const c of failing) {
    const m = parseJSON<Record<string, unknown>>(c.measures, {});
    const key = c.status === "ERROR" ? "harness" : m.falseAccept ? `gate-false-accept:${c.category}` : m.falseReject ? `gate-false-reject:${c.category}` : `${c.benchmarkId.split("-")[0]}:${c.category}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const items: BacklogEntry[] = [...groups.entries()].map(([key, cs]) => ({
    key,
    risk: key.startsWith("gate-false-accept") ? (["security", "auth"].some((s) => key.includes(s)) ? "critical" : "high") : cs.some((c) => c.split === "heldout") ? "medium" : "low",
    evidence: cs.map((c) => ({ kind: "lab_case", ref: c.id, detail: `${c.benchmarkId} (${c.split}) ${c.status}: ${parseJSON<{ evidence: string }[]>(c.criteria, []).find((x) => x)?.evidence ?? c.error}` })),
    previouslyRejected: tried.has(key),
  }));
  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
  items.sort((a, b) => rank[a.risk] - rank[b.risk] || b.evidence.length - a.evidence.length);
  await saveState(companyId, { backlog: items, nextAction: items[0] ? `address ${items[0].key} (${items[0].risk}, ${items[0].evidence.length} failing case(s))` : "no failing benchmarks in the latest run; extend the suite" });
  return { runId: run.id, items };
}
export interface BacklogEntry { key: string; risk: string; evidence: { kind: string; ref: string; detail: string }[]; previouslyRejected: boolean }

export async function labOverview(companyId: string) {
  const [state, runs, experiments] = await Promise.all([
    loadState(companyId),
    prisma.labRun.findMany({ where: { companyId }, orderBy: { startedAt: "desc" }, take: 20, select: { id: true, suiteVersion: true, split: true, configKey: true, executor: true, label: true, status: true, total: true, passed: true, failed: true, errored: true, skipped: true, durationMs: true, sandboxMs: true, metrics: true, experimentId: true, startedAt: true, error: true } }),
    prisma.labExperiment.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  return {
    state: { ...state, backlog: parseJSON(state.backlog, []), blockers: parseJSON(state.blockers, []), regressions: parseJSON(state.regressions, []) },
    suiteVersion: SUITE_VERSION,
    executor: await chooseExecutor(),
    runs: runs.map((r) => ({ ...r, metrics: parseJSON(r.metrics, {}) })),
    experiments: experiments.map((e) => ({ ...e, evidence: parseJSON(e.evidence, []), successCriteria: parseJSON(e.successCriteria, []), regressionCriteria: parseJSON(e.regressionCriteria, []), decision: parseJSON(e.decision, {}) })),
  };
}
