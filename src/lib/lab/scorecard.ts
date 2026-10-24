/**
 * Multi-dimensional scorecard for a lab run. Every metric is
 * { value, numerator, denominator, formula }; a metric with no measured
 * cases is `null` (shown as "not measured"), never a guessed number.
 *
 * No aggregate score is produced: the dimensions are reported separately and
 * the experiment decision rules (experiments.ts) name the metrics they use.
 * Dimensions from the V5 brief that the lab does not measure are listed in
 * `notMeasured` with the reason.
 */
import type { CaseOutcome } from "./runner";

export interface Metric { value: number | null; numerator: number; denominator: number; formula: string }
export interface Scorecard {
  split: string;
  dimensions: Record<string, Record<string, Metric>>;
  criticalFailures: string[]; // benchmark ids that falsely ACCEPTED a bad change (never averaged away)
  notMeasured: { dimension: string; reason: string }[];
}

const m = (num: number, den: number, formula: string): Metric => ({ value: den ? num / den : null, numerator: num, denominator: den, formula });

export function scorecard(cases: CaseOutcome[], split = "all"): Scorecard {
  const sel = cases.filter((c) => split === "all" || c.split === split);
  const ran = sel.filter((c) => c.status !== "SKIPPED");
  const of = (kind: string) => ran.filter((c) => c.kind === kind && c.status !== "ERROR");
  const gate = of("gate");
  const bad = gate.filter((c) => c.measures.expected === "reject");
  const good = gate.filter((c) => c.measures.expected === "accept");
  const ctx = of("context");
  const diag = of("diagnose");
  const imp = of("impact");
  const rec = of("recover");
  const security = gate.filter((c) => ["security", "auth"].includes(c.category));
  const sum = (xs: CaseOutcome[], k: string) => xs.reduce((s, c) => s + (typeof c.measures[k] === "number" ? (c.measures[k] as number) : 0), 0);
  const durations = ran.map((c) => c.durationMs);
  return {
    split,
    dimensions: {
      functional: {
        casesPassed: m(ran.filter((c) => c.status === "PASSED").length, ran.length, "benchmarks whose every acceptance criterion passed / benchmarks run"),
        correctAccepts: m(good.filter((c) => c.measures.decision === "accept").length, good.length, "correct changes the gate accepted / correct changes"),
      },
      engineeringQuality: {
        badChangeRejection: m(bad.filter((c) => c.measures.decision === "reject").length, bad.length, "defective changes the gate rejected / defective changes"),
        contextRecall: m(sum(ctx, "recall"), ctx.length, "mean share of required files in the selected context"),
        contextPrecision: m(sum(ctx, "precision"), ctx.length, "mean share of selected files that were required"),
        impactCorrect: m(imp.filter((c) => c.status === "PASSED").length, imp.length, "impact analyses with the expected tests/flags / impact cases"),
      },
      autonomy: {
        diagnosisCorrect: m(diag.filter((c) => c.criteria.find((x) => x.id === "category")?.passed).length, diag.length, "failures classified into the expected category / diagnosis cases"),
        recoveryCorrect: m(rec.filter((c) => c.status === "PASSED").length, rec.length, "recovery cases with the expected state / recovery cases"),
      },
      reliability: {
        harnessErrors: m(sel.filter((c) => c.status === "ERROR").length, sel.length, "benchmarks that errored (harness/infrastructure) / benchmarks"),
      },
      security: {
        securityRejections: m(security.filter((c) => (c.measures.expected === "reject") === (c.measures.decision === "reject")).length, security.length, "security/auth gate cases decided correctly / security/auth cases"),
      },
      economics: {
        meanCaseMs: m(durations.reduce((s, d) => s + d, 0), durations.length, "mean wall time per benchmark (ms)"),
        sandboxMs: m(ran.reduce((s, c) => s + c.sandboxMs, 0), 1, "total command execution time (ms)"),
        contextChars: m(sum(ctx, "contextChars"), ctx.length, "mean characters of file content selected as context"),
        falseRejectRate: m(good.filter((c) => c.measures.decision === "reject").length, good.length, "correct changes rejected (wasted repair rounds) / correct changes"),
      },
    },
    criticalFailures: bad.filter((c) => c.measures.decision === "accept").map((c) => c.benchmarkId),
    notMeasured: [
      { dimension: "customerExperience", reason: "no real user feedback or onboarding telemetry is collected by the lab" },
      { dimension: "economics.providerCost", reason: "lab benchmarks make no model calls; provider cost is measured by the intelligence evaluations and real runs" },
      { dimension: "functional.criticalJourneys", reason: "no browser execution of generated applications yet" },
    ],
  };
}

export function metricValue(card: Scorecard, path: string): number | null {
  const [dim, key] = path.split(".");
  return card.dimensions[dim]?.[key]?.value ?? null;
}
