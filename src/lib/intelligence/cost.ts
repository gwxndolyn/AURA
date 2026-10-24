/**
 * Evidence-based cost/budget optimization recommendations. Pure. Each
 * recommendation carries its supporting evidence, sample size, expected impact,
 * confidence, risks, and verification method — and is a PROPOSAL, never an
 * auto-applied change (docs Phase 12).
 */
import type { ModelPerformance } from "./routing";

export interface CostRecommendation {
  id: string;
  kind: "cheaper-model" | "redundant-context" | "unnecessary-handoff" | "retry-waste" | "replace-model-call-with-code";
  title: string;
  evidence: string;
  sampleSize: number;
  expectedImpact: string;
  confidence: "low" | "medium" | "high";
  risks: string;
  verification: string;
}

export interface CostSignals {
  taskCategory: string;
  /** Model performance records for this category (to spot a cheaper equal model). */
  models: ModelPerformance[];
  /** Avg redundant/duplicate context tokens observed per run (0 if unknown). */
  avgRedundantContextTokens: number;
  /** Fraction of runs with an avoidable handoff. */
  avoidableHandoffRate: number;
  /** Fraction of retries that repeated a permanent (non-transient) failure. */
  permanentRetryRate: number;
  /** Fraction of model calls that could be a deterministic code check. */
  modelCallsReplaceableByCode: number;
  sampleSize: number;
}

function confidenceFor(sampleSize: number, strength: number): CostRecommendation["confidence"] {
  if (sampleSize >= 20 && strength >= 0.5) return "high";
  if (sampleSize >= 5 && strength >= 0.25) return "medium";
  return "low";
}

export function costRecommendations(signals: CostSignals): CostRecommendation[] {
  const recs: CostRecommendation[] = [];
  const n = signals.sampleSize;

  // 1. Cheaper model that performs similarly on this category.
  const eligible = signals.models.filter((m) => m.sampleSize >= 5 && m.available);
  if (eligible.length >= 2) {
    const byCorrectness = [...eligible].sort((a, b) => b.correctness - a.correctness);
    const best = byCorrectness[0];
    const cheaperSimilar = eligible
      .filter((m) => m.model !== best.model && m.avgCost < best.avgCost && m.correctness >= best.correctness - 0.03 && m.securityScore >= best.securityScore)
      .sort((a, b) => a.avgCost - b.avgCost)[0];
    if (cheaperSimilar) {
      const savings = best.avgCost - cheaperSimilar.avgCost;
      recs.push({
        id: `cheaper-model:${signals.taskCategory}`,
        kind: "cheaper-model",
        title: `Route "${signals.taskCategory}" to ${cheaperSimilar.model} instead of ${best.model}`,
        evidence: `${cheaperSimilar.model} correctness ${cheaperSimilar.correctness.toFixed(2)} vs ${best.model} ${best.correctness.toFixed(2)} (within 0.03), security ${cheaperSimilar.securityScore.toFixed(2)}≥${best.securityScore.toFixed(2)}, cost $${cheaperSimilar.avgCost.toFixed(4)} vs $${best.avgCost.toFixed(4)}.`,
        sampleSize: Math.min(best.sampleSize, cheaperSimilar.sampleSize),
        expectedImpact: `~$${savings.toFixed(4)}/task saved (${best.avgCost > 0 ? Math.round((savings / best.avgCost) * 100) : 0}%).`,
        confidence: confidenceFor(Math.min(best.sampleSize, cheaperSimilar.sampleSize), savings / (best.avgCost || 1)),
        risks: "Correctness/security parity is within sample noise; verify on the full dataset before promoting.",
        verification: "Run a prompt/model experiment on this category's dataset; promote only if gates pass.",
      });
    }
  }

  // 2. Redundant context.
  if (signals.avgRedundantContextTokens > 200) {
    recs.push({
      id: `redundant-context:${signals.taskCategory}`,
      kind: "redundant-context",
      title: `Trim redundant context for "${signals.taskCategory}"`,
      evidence: `~${Math.round(signals.avgRedundantContextTokens)} redundant input tokens/run observed.`,
      sampleSize: n,
      expectedImpact: `Lower input tokens → proportional input-cost + latency reduction.`,
      confidence: confidenceFor(n, Math.min(1, signals.avgRedundantContextTokens / 1000)),
      risks: "Trimming the wrong context can hurt correctness — never trade correctness for tokens.",
      verification: "Use the context-engineering prompt; re-run evals and confirm pass rate holds.",
    });
  }

  // 3. Unnecessary handoff.
  if (signals.avoidableHandoffRate > 0.1) {
    recs.push({
      id: `unnecessary-handoff:${signals.taskCategory}`,
      kind: "unnecessary-handoff",
      title: `Remove avoidable agent handoff in "${signals.taskCategory}"`,
      evidence: `${Math.round(signals.avoidableHandoffRate * 100)}% of runs include an avoidable handoff.`,
      sampleSize: n,
      expectedImpact: `Fewer model calls → lower cost + latency.`,
      confidence: confidenceFor(n, signals.avoidableHandoffRate),
      risks: "The handoff may provide needed specialization; confirm the single agent still passes evals.",
      verification: "A/B the workflow with/without the handoff on the dataset.",
    });
  }

  // 4. Retry waste on permanent failures.
  if (signals.permanentRetryRate > 0.1) {
    recs.push({
      id: `retry-waste:${signals.taskCategory}`,
      kind: "retry-waste",
      title: `Stop retrying permanent failures in "${signals.taskCategory}"`,
      evidence: `${Math.round(signals.permanentRetryRate * 100)}% of retries repeated a non-transient failure (auth/validation).`,
      sampleSize: n,
      expectedImpact: `Eliminate wasted model calls on deterministic failures.`,
      confidence: confidenceFor(n, signals.permanentRetryRate),
      risks: "Must correctly classify transient vs permanent; mis-class risks losing a recoverable retry.",
      verification: "Inspect error classification; add a failure-category guard before retrying.",
    });
  }

  // 5. Replace a model call with deterministic code.
  if (signals.modelCallsReplaceableByCode > 0.1) {
    recs.push({
      id: `replace-with-code:${signals.taskCategory}`,
      kind: "replace-model-call-with-code",
      title: `Replace a model call with a deterministic check in "${signals.taskCategory}"`,
      evidence: `${Math.round(signals.modelCallsReplaceableByCode * 100)}% of model calls perform work a deterministic validator could do.`,
      sampleSize: n,
      expectedImpact: `Remove model calls entirely for that step → cost + latency + reliability gain.`,
      confidence: confidenceFor(n, signals.modelCallsReplaceableByCode),
      risks: "Only applies where the decision is truly deterministic; don't replace genuine reasoning.",
      verification: "Implement the check behind the same contract; evals must still pass.",
    });
  }

  return recs;
}
