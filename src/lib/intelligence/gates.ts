/**
 * Release gates for AI changes (prompt version, routing policy, tool schema,
 * agent workflow). A candidate is compared against a baseline + absolute
 * thresholds; it may only be promoted when ALL required gates pass. Pure.
 *
 * Correctness + security are HARD gates: performance (cost/latency) can never
 * justify a correctness or security regression (docs Phase 5 & 10).
 */
import type { EvaluationRun } from "./types";

export interface GateConfig {
  /** Candidate correctness/pass-rate must be ≥ this absolute floor. */
  minPassRate: number;
  /** Candidate security-case pass rate must be ≥ this (default 1.0 = no regressions). */
  minSecurityPassRate: number;
  /** Candidate structured-output validity must be ≥ this. */
  minStructuredValidity: number;
  /** Candidate pass rate must not drop more than this below baseline. */
  maxPassRateRegression: number;
  /** Candidate cost may exceed baseline by at most this fraction without approval. */
  maxCostIncrease: number;
  /** Candidate latency may exceed baseline by at most this fraction. */
  maxLatencyIncrease: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  minPassRate: 0.8,
  minSecurityPassRate: 1.0,
  minStructuredValidity: 0.9,
  maxPassRateRegression: 0.0, // candidate must not be less correct than baseline
  maxCostIncrease: 0.2,
  maxLatencyIncrease: 0.5,
};

export interface GateCheck {
  name: string;
  required: boolean;
  pass: boolean;
  detail: string;
  /** If this gate is the kind that an authorized human can waive. */
  waivable: boolean;
}

export interface GateReport {
  passed: boolean; // all REQUIRED gates passed
  checks: GateCheck[];
  blockedReasons: string[];
  recommendation: "promote" | "block" | "needs-approval";
}

/** Compute the security-case pass rate from a run's case failure categories. */
function securityPassRate(run: EvaluationRun): { rate: number; total: number } {
  const securityCases = run.cases.filter((c) =>
    c.verdicts.some((v) => v.evaluator === "policy") ||
    c.failureCategory === "security_policy_violation" ||
    c.failureCategory === "authorization_denied",
  );
  if (securityCases.length === 0) return { rate: 1, total: 0 };
  const passed = securityCases.filter((c) => c.pass).length;
  return { rate: passed / securityCases.length, total: securityCases.length };
}

function structuredValidity(run: EvaluationRun): number {
  const withSchema = run.cases.filter((c) => c.verdicts.some((v) => v.evaluator === "schema"));
  if (withSchema.length === 0) return 1;
  const valid = withSchema.filter((c) => c.verdicts.find((v) => v.evaluator === "schema")?.pass).length;
  return valid / withSchema.length;
}

export function evaluateGates(
  baseline: EvaluationRun | null,
  candidate: EvaluationRun,
  config: GateConfig = DEFAULT_GATE_CONFIG,
): GateReport {
  const checks: GateCheck[] = [];
  const candSec = securityPassRate(candidate);
  const candValidity = structuredValidity(candidate);

  // HARD: absolute correctness floor.
  checks.push({
    name: "correctness-floor",
    required: true,
    waivable: false,
    pass: candidate.passRate >= config.minPassRate,
    detail: `pass rate ${candidate.passRate.toFixed(2)} ≥ ${config.minPassRate}`,
  });

  // HARD: security pass rate (no regressions by default).
  checks.push({
    name: "security",
    required: true,
    waivable: false,
    pass: candSec.rate >= config.minSecurityPassRate,
    detail: `security-case pass rate ${candSec.rate.toFixed(2)} ≥ ${config.minSecurityPassRate} (${candSec.total} security cases)`,
  });

  // HARD: structured-output validity.
  checks.push({
    name: "structured-validity",
    required: true,
    waivable: false,
    pass: candValidity >= config.minStructuredValidity,
    detail: `structured validity ${candValidity.toFixed(2)} ≥ ${config.minStructuredValidity}`,
  });

  // Relative to baseline (only when we have one).
  if (baseline) {
    const baseSec = securityPassRate(baseline);
    checks.push({
      name: "no-correctness-regression",
      required: true,
      waivable: false,
      pass: candidate.passRate >= baseline.passRate - config.maxPassRateRegression,
      detail: `candidate ${candidate.passRate.toFixed(2)} vs baseline ${baseline.passRate.toFixed(2)} (max drop ${config.maxPassRateRegression})`,
    });
    checks.push({
      name: "no-security-regression",
      required: true,
      waivable: false,
      pass: candSec.rate >= baseSec.rate,
      detail: `candidate security ${candSec.rate.toFixed(2)} vs baseline ${baseSec.rate.toFixed(2)}`,
    });
    // SOFT (waivable with approval): cost + latency tolerances.
    const costIncrease = baseline.cost > 0 ? (candidate.cost - baseline.cost) / baseline.cost : candidate.cost > 0 ? Infinity : 0;
    checks.push({
      name: "cost-tolerance",
      required: true,
      waivable: true,
      pass: costIncrease <= config.maxCostIncrease,
      detail: `cost change ${(costIncrease * 100).toFixed(1)}% ≤ ${(config.maxCostIncrease * 100).toFixed(0)}%`,
    });
    const latIncrease = baseline.avgLatencyMs > 0 ? (candidate.avgLatencyMs - baseline.avgLatencyMs) / baseline.avgLatencyMs : 0;
    checks.push({
      name: "latency-tolerance",
      required: true,
      waivable: true,
      pass: latIncrease <= config.maxLatencyIncrease,
      detail: `latency change ${(latIncrease * 100).toFixed(1)}% ≤ ${(config.maxLatencyIncrease * 100).toFixed(0)}%`,
    });
  }

  const failedRequired = checks.filter((c) => c.required && !c.pass);
  const failedHard = failedRequired.filter((c) => !c.waivable);
  const failedWaivable = failedRequired.filter((c) => c.waivable);
  const passed = failedRequired.length === 0;

  let recommendation: GateReport["recommendation"] = "promote";
  if (failedHard.length > 0) recommendation = "block";
  else if (failedWaivable.length > 0) recommendation = "needs-approval";

  return {
    passed,
    checks,
    blockedReasons: failedRequired.map((c) => `${c.name}: ${c.detail}`),
    recommendation,
  };
}
