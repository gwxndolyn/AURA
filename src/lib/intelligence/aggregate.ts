/**
 * Aggregate a list of per-case results into an EvaluationRun summary. Pure.
 * Shared by the evaluation engine and tests so the math has one source of truth.
 *
 * Skipped cases (Docker unavailable, budget stop, cancellation) are EXCLUDED from
 * every rate — they are reported separately so a skip never inflates or deflates
 * the pass rate.
 */
import type { CaseResult, EvaluationRun } from "./types";
import { groupFailures } from "./failures";
import type { FailureCategory } from "./failures";

export interface RunMeta {
  evaluationId: string;
  agentKey: string;
  workflow: string;
  provider: string;
  model: string;
  mode: "live" | "simulation";
  promptId: string;
  promptVersion: string;
  toolSchemaVersion?: string;
  datasetId: string;
  datasetVersion: string;
  startedAt: string;
  finishedAt: string;
}

/** Nearest-rank percentile. Returns null when fewer than `minN` samples. */
export function percentile(values: number[], p: number, minN = 5): number | null {
  if (values.length < minN) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function aggregateRun(meta: RunMeta, allCases: CaseResult[]): EvaluationRun {
  const cases = allCases.filter((c) => !c.skipped);
  const skipped = allCases.length - cases.length;
  const total = cases.length;
  const passed = cases.filter((c) => c.pass).length;
  const failed = total - passed;
  // Cost/tokens include skipped cases' spend (money spent is money spent).
  const tokensIn = allCases.reduce((s, c) => s + (c.tokensIn ?? 0), 0);
  const tokensOut = allCases.reduce((s, c) => s + (c.tokensOut ?? 0), 0);
  const cost = allCases.reduce((s, c) => s + (c.cost ?? 0), 0);
  const latencies = cases.map((c) => c.latencyMs ?? 0);
  const avgLatencyMs = total ? latencies.reduce((s, v) => s + v, 0) / total : 0;
  const avgScore = total ? cases.reduce((s, c) => s + c.score, 0) / total : 0;
  const failureCounts = groupFailures(
    cases.filter((c) => !c.pass).map((c) => c.failureCategory).filter((c): c is FailureCategory => !!c),
  );

  return {
    ...meta,
    cases: allCases,
    total,
    passed,
    failed,
    skipped,
    passRate: total ? passed / total : 0,
    avgScore,
    tokensIn,
    tokensOut,
    cost,
    costPerPass: passed ? cost / passed : null,
    avgLatencyMs,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    failureCounts,
  };
}
