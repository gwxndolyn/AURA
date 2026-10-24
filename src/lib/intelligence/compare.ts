/**
 * Compare two evaluation runs (baseline vs candidate) for a prompt/model
 * experiment and produce an evidence-based recommendation. Pure.
 *
 * A candidate is NOT recommended merely for being cheaper/faster — it must first
 * clear the release gates (correctness + security). Performance only breaks ties
 * or justifies an equal-correctness swap.
 */
import type { EvaluationRun } from "./types";
import { evaluateGates, type GateConfig, type GateReport, DEFAULT_GATE_CONFIG } from "./gates";

export interface Delta {
  metric: string;
  baseline: number;
  candidate: number;
  absolute: number;
  relative: number | null; // null when baseline is 0
  betterIsLower?: boolean;
}

export interface ComparisonResult {
  baselineId: string;
  candidateId: string;
  deltas: Delta[];
  gates: GateReport;
  recommendation: "promote" | "block" | "needs-approval";
  summary: string;
}

function delta(metric: string, b: number, c: number, betterIsLower = false): Delta {
  return {
    metric,
    baseline: b,
    candidate: c,
    absolute: c - b,
    relative: b === 0 ? null : (c - b) / b,
    betterIsLower,
  };
}

export function compareRuns(
  baseline: EvaluationRun,
  candidate: EvaluationRun,
  gateConfig: GateConfig = DEFAULT_GATE_CONFIG,
): ComparisonResult {
  const deltas: Delta[] = [
    delta("passRate", baseline.passRate, candidate.passRate),
    delta("avgScore", baseline.avgScore, candidate.avgScore),
    delta("cost", baseline.cost, candidate.cost, true),
    delta("costPerPass", baseline.costPerPass ?? 0, candidate.costPerPass ?? 0, true),
    delta("avgLatencyMs", baseline.avgLatencyMs, candidate.avgLatencyMs, true),
    delta("tokensTotal", baseline.tokensIn + baseline.tokensOut, candidate.tokensIn + candidate.tokensOut, true),
  ];

  const gates = evaluateGates(baseline, candidate, gateConfig);

  const correctnessDelta = candidate.passRate - baseline.passRate;
  const costDelta = (candidate.costPerPass ?? 0) - (baseline.costPerPass ?? 0);
  let summary: string;
  if (gates.recommendation === "block") {
    summary = `BLOCK: candidate fails a hard gate (${gates.blockedReasons.join("; ")}). Keep baseline active.`;
  } else if (gates.recommendation === "needs-approval") {
    summary = `NEEDS APPROVAL: correctness/security gates pass but a cost/latency tolerance was exceeded (${gates.blockedReasons.join("; ")}). Requires authorized approval.`;
  } else {
    const parts = [
      `correctness ${correctnessDelta >= 0 ? "+" : ""}${(correctnessDelta * 100).toFixed(1)}pp`,
      `cost/pass ${costDelta <= 0 ? "" : "+"}$${costDelta.toFixed(4)}`,
    ];
    summary = `PROMOTE eligible: all required gates pass (${parts.join(", ")}).`;
  }

  return {
    baselineId: baseline.evaluationId,
    candidateId: candidate.evaluationId,
    deltas,
    gates,
    recommendation: gates.recommendation,
    summary,
  };
}

/** Variance across repeated runs of the same (nondeterministic) config. */
export function summarizeVariance(runs: EvaluationRun[]): {
  n: number;
  passRateMean: number | null;
  passRateMin: number | null;
  passRateMax: number | null;
  passRateStdev: number | null;
  costMean: number | null;
} {
  const n = runs.length;
  if (n === 0) return { n: 0, passRateMean: null, passRateMin: null, passRateMax: null, passRateStdev: null, costMean: null };
  const rates = runs.map((r) => r.passRate);
  const mean = rates.reduce((s, v) => s + v, 0) / n;
  const variance = rates.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return {
    n,
    passRateMean: mean,
    passRateMin: Math.min(...rates),
    passRateMax: Math.max(...rates),
    passRateStdev: Math.sqrt(variance),
    costMean: runs.reduce((s, r) => s + r.cost, 0) / n,
  };
}
