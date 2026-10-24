/**
 * Agent scorecards. Pure functions over a list of run records. Every metric
 * states its denominator and the sample size, and we expose confidence
 * limitations so a 1/1 run never reads as a trustworthy "100%".
 *
 * See docs/ai-engineering/evaluation-and-testing.md.
 */
import type { FailureCategory } from "./failures";
import { groupFailures } from "./failures";

/**
 * One observed run of an agent (an evaluation case OR a real task). This is the
 * normalized shape the scorecard consumes; the persistence layer maps DB rows
 * to this.
 */
export interface RunRecord {
  agentKey: string;
  pass: boolean; // acceptance satisfied / output valid+correct
  completed: boolean; // reached a terminal non-error state
  retries: number;
  timedOut: boolean;
  toolCalls: number;
  toolFailures: number;
  recovered: boolean; // recovered after a failure (self-heal)
  recoveryAttempted: boolean;
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  latencyMs: number;
  // security
  unauthorizedAttempts: number;
  policyViolations: number;
  unsafeOutput: boolean;
  injectionResisted?: boolean; // only set for injection cases
  injectionCase?: boolean;
  escalationExpected?: boolean;
  escalatedCorrectly?: boolean;
  // collaboration
  handoff?: boolean;
  handoffSucceeded?: boolean;
  handoffRework?: boolean;
  conflictingDecision?: boolean;
  missingContext?: boolean;
  failureCategory?: FailureCategory;
  // quality flags (optional; default-safe)
  _ranTests?: boolean; // this run executed tests (for correctness-by-tests denominator)
  _outputValid?: boolean; // output passed schema/validity (default true if omitted)
  _regression?: boolean; // this run regressed vs a prior passing baseline
}

/** A metric with its value, the counts behind it, and how it's computed. */
export interface Metric {
  value: number | null; // null when denominator is 0 (no data)
  numerator: number;
  denominator: number;
  formula: string;
  unit?: string;
}

function ratio(num: number, den: number, formula: string, unit?: string): Metric {
  return { value: den === 0 ? null : num / den, numerator: num, denominator: den, formula, unit };
}
function avg(values: number[], formula: string, unit?: string): Metric {
  const den = values.length;
  const num = values.reduce((s, v) => s + v, 0);
  return { value: den === 0 ? null : num / den, numerator: num, denominator: den, formula, unit };
}

export interface SampleConfidence {
  sampleSize: number;
  level: "none" | "very-low" | "low" | "moderate" | "high";
  note: string;
}

export function sampleConfidence(n: number): SampleConfidence {
  if (n === 0) return { sampleSize: 0, level: "none", note: "No evaluated runs yet." };
  if (n < 5) return { sampleSize: n, level: "very-low", note: "Too few runs to be meaningful; treat as indicative only." };
  if (n < 20) return { sampleSize: n, level: "low", note: "Small sample; rates may be noisy." };
  if (n < 50) return { sampleSize: n, level: "moderate", note: "Moderate sample." };
  return { sampleSize: n, level: "high", note: "Reasonable sample size." };
}

export interface Scorecard {
  agentKey: string;
  sampleSize: number;
  confidence: SampleConfidence;
  quality: {
    acceptanceSatisfied: Metric;
    outputValidity: Metric;
    correctnessByTests: Metric; // among runs that ran tests
    regressionRate: Metric;
  };
  reliability: {
    completionRate: Metric;
    retryRate: Metric; // avg retries per run
    timeoutRate: Metric;
    toolFailureRate: Metric; // tool failures / tool calls
    recoverySuccessRate: Metric; // recovered / recoveryAttempted
  };
  efficiency: {
    avgLatencyMs: Metric;
    avgTokens: Metric;
    costPerSuccess: Metric; // total cost / passes
    avgModelCalls: Metric;
    avgToolCalls: Metric;
  };
  security: {
    unauthorizedAttempts: Metric; // total count (per run)
    policyViolationRate: Metric;
    unsafeOutputRate: Metric;
    injectionResistanceRate: Metric; // among injection cases
    correctEscalationRate: Metric; // among escalation-expected cases
  };
  collaboration: {
    handoffSuccessRate: Metric; // among handoffs
    handoffReworkRate: Metric;
    conflictingDecisionRate: Metric;
    missingContextRate: Metric;
  };
  topFailures: { category: FailureCategory; count: number }[];
}

export function computeScorecard(agentKey: string, runs: RunRecord[]): Scorecard {
  const n = runs.length;
  const passes = runs.filter((r) => r.pass).length;
  const totalCost = runs.reduce((s, r) => s + r.cost, 0);

  const ranTests = runs.filter((r) => r._ranTests === true);
  const injectionCases = runs.filter((r) => r.injectionCase === true);
  const escalationCases = runs.filter((r) => r.escalationExpected === true);
  const handoffs = runs.filter((r) => r.handoff === true);
  const recoveryRuns = runs.filter((r) => r.recoveryAttempted === true);
  const toolCallTotal = runs.reduce((s, r) => s + r.toolCalls, 0);
  const toolFailTotal = runs.reduce((s, r) => s + r.toolFailures, 0);

  return {
    agentKey,
    sampleSize: n,
    confidence: sampleConfidence(n),
    quality: {
      acceptanceSatisfied: ratio(passes, n, "passes / total runs"),
      outputValidity: ratio(runs.filter((r) => r._outputValid !== false).length, n, "valid-output runs / total"),
      correctnessByTests: ratio(ranTests.filter((r) => r.pass).length, ranTests.length, "passing runs that executed tests / runs that executed tests"),
      regressionRate: ratio(runs.filter((r) => r._regression === true).length, n, "regressions / total runs"),
    },
    reliability: {
      completionRate: ratio(runs.filter((r) => r.completed).length, n, "completed runs / total"),
      retryRate: avg(runs.map((r) => r.retries), "sum(retries) / total runs", "retries/run"),
      timeoutRate: ratio(runs.filter((r) => r.timedOut).length, n, "timed-out runs / total"),
      toolFailureRate: ratio(toolFailTotal, toolCallTotal, "tool failures / tool calls"),
      recoverySuccessRate: ratio(recoveryRuns.filter((r) => r.recovered).length, recoveryRuns.length, "recovered / recovery attempts"),
    },
    efficiency: {
      avgLatencyMs: avg(runs.map((r) => r.latencyMs), "sum(latency) / total runs", "ms"),
      avgTokens: avg(runs.map((r) => r.tokensIn + r.tokensOut), "sum(tokens) / total runs", "tokens"),
      costPerSuccess: ratio(totalCost, passes, "total cost / passing runs", "USD"),
      avgModelCalls: avg(runs.map((r) => r.modelCalls), "sum(model calls) / total runs"),
      avgToolCalls: avg(runs.map((r) => r.toolCalls), "sum(tool calls) / total runs"),
    },
    security: {
      unauthorizedAttempts: avg(runs.map((r) => r.unauthorizedAttempts), "sum(unauthorized attempts) / total runs", "attempts/run"),
      policyViolationRate: ratio(runs.filter((r) => r.policyViolations > 0).length, n, "runs with a policy violation / total"),
      unsafeOutputRate: ratio(runs.filter((r) => r.unsafeOutput).length, n, "unsafe-output runs / total"),
      injectionResistanceRate: ratio(injectionCases.filter((r) => r.injectionResisted === true).length, injectionCases.length, "resisted / injection cases"),
      correctEscalationRate: ratio(escalationCases.filter((r) => r.escalatedCorrectly === true).length, escalationCases.length, "correct escalations / escalation-expected cases"),
    },
    collaboration: {
      handoffSuccessRate: ratio(handoffs.filter((r) => r.handoffSucceeded === true).length, handoffs.length, "successful handoffs / handoffs"),
      handoffReworkRate: ratio(handoffs.filter((r) => r.handoffRework === true).length, handoffs.length, "handoffs needing rework / handoffs"),
      conflictingDecisionRate: ratio(runs.filter((r) => r.conflictingDecision === true).length, n, "conflicting-decision runs / total"),
      missingContextRate: ratio(runs.filter((r) => r.missingContext === true).length, n, "missing-context runs / total"),
    },
    topFailures: groupFailures(runs.map((r) => r.failureCategory).filter((c): c is FailureCategory => !!c)).slice(0, 5),
  };
}
