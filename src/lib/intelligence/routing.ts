/**
 * Evidence-based model routing. Chooses a model for a task category using
 * recorded evaluation performance + a configurable policy. Pure functions.
 *
 * Principles (docs/ai-engineering/model-routing.md):
 *  - Lower tier only when it meets correctness + security thresholds.
 *  - Never route security-sensitive work to an unqualified model to save cost.
 *  - Safe default when evidence is insufficient.
 *  - A more expensive model is NOT assumed better; a cheaper one is NOT assumed
 *    interchangeable — the decision is made from measured results.
 */
import type { ModelTier } from "@/lib/types";

/** Measured performance of one model on one task category. */
export interface ModelPerformance {
  model: string;
  tier: ModelTier;
  taskCategory: string;
  sampleSize: number;
  correctness: number; // 0..1 (pass rate on correctness evaluators)
  taskSuccess: number; // 0..1
  structuredValidity: number; // 0..1
  toolCallSuccess: number; // 0..1
  securityScore: number; // 0..1 (security evaluators pass rate)
  reliability: number; // 0..1 (completion rate)
  avgCost: number; // USD per task
  avgLatencyMs: number;
  available: boolean;
  /** "live" = real provider evidence; "simulation" = deterministic fixture. Only live evidence may drive routing. */
  evidenceMode?: "live" | "simulation";
}

export interface RoutingPolicy {
  /** Minimum correctness a candidate must meet to be eligible. */
  minCorrectness: number;
  /** Minimum security score; higher for security-sensitive categories. */
  minSecurity: number;
  /** Minimum structured-output validity. */
  minStructuredValidity: number;
  /** Minimum sample size before trusting evidence; below this → safe default. */
  minSampleSize: number;
  /** Task categories considered security-sensitive (stricter thresholds). */
  securitySensitive: string[];
  /** Security-sensitive minimum security score. */
  securitySensitiveMinSecurity: number;
  /** When eligible candidates tie on correctness within this epsilon, prefer cheaper. */
  correctnessTieEpsilon: number;
  /** The safe default tier when evidence is insufficient. */
  safeDefaultTier: ModelTier;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  minCorrectness: 0.8,
  minSecurity: 0.9,
  minStructuredValidity: 0.9,
  minSampleSize: 5,
  securitySensitive: ["security", "red-team", "blue-team", "security-engineer"],
  securitySensitiveMinSecurity: 1.0,
  correctnessTieEpsilon: 0.03,
  safeDefaultTier: "STANDARD",
};

export interface RoutingDecision {
  taskCategory: string;
  chosen: ModelPerformance | null;
  usedSafeDefault: boolean;
  reason: string;
  consideredCount: number;
  eligibleCount: number;
}

/**
 * Choose a model for a task category from measured performance records.
 * Falls back to a safe default (no choice) when evidence is insufficient.
 */
export function routeModel(
  taskCategory: string,
  candidates: ModelPerformance[],
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): RoutingDecision {
  const isSensitive = policy.securitySensitive.some((s) => taskCategory.includes(s));
  const minSecurity = isSensitive ? policy.securitySensitiveMinSecurity : policy.minSecurity;

  // Fixture (simulator) results measure the harness, not a model — never route on them.
  const forCategory = candidates.filter((c) => c.taskCategory === taskCategory && c.available && c.evidenceMode !== "simulation");

  // Insufficient evidence → safe default (no specific model choice).
  const withEnoughData = forCategory.filter((c) => c.sampleSize >= policy.minSampleSize);
  if (withEnoughData.length === 0) {
    return {
      taskCategory,
      chosen: null,
      usedSafeDefault: true,
      reason: `Insufficient evidence (no candidate with ≥${policy.minSampleSize} samples). Using safe default tier ${policy.safeDefaultTier}.`,
      consideredCount: forCategory.length,
      eligibleCount: 0,
    };
  }

  // Eligibility: must clear correctness, security, structured-validity thresholds.
  const eligible = withEnoughData.filter(
    (c) =>
      c.correctness >= policy.minCorrectness &&
      c.securityScore >= minSecurity &&
      c.structuredValidity >= policy.minStructuredValidity,
  );

  if (eligible.length === 0) {
    return {
      taskCategory,
      chosen: null,
      usedSafeDefault: true,
      reason: `No candidate met thresholds (correctness≥${policy.minCorrectness}, security≥${minSecurity}, validity≥${policy.minStructuredValidity}). Using safe default tier ${policy.safeDefaultTier}.`,
      consideredCount: forCategory.length,
      eligibleCount: 0,
    };
  }

  // Rank: correctness first; when within epsilon, prefer cheaper then faster.
  const best = [...eligible].sort((a, b) => {
    if (Math.abs(a.correctness - b.correctness) > policy.correctnessTieEpsilon) return b.correctness - a.correctness;
    if (a.avgCost !== b.avgCost) return a.avgCost - b.avgCost;
    return a.avgLatencyMs - b.avgLatencyMs;
  })[0];

  const cheaperExists = eligible.some((c) => c.avgCost < best.avgCost);
  const reason = isSensitive
    ? `Security-sensitive category: chose ${best.model} meeting strict security≥${minSecurity} (security=${best.securityScore.toFixed(2)}), correctness=${best.correctness.toFixed(2)}.`
    : cheaperExists && !eligible.some((c) => c.avgCost < best.avgCost && c.correctness >= best.correctness - policy.correctnessTieEpsilon)
      ? `Chose ${best.model}: best correctness=${best.correctness.toFixed(2)} within budget; cheaper models did not match correctness.`
      : `Chose ${best.model}: correctness=${best.correctness.toFixed(2)}, cost=$${best.avgCost.toFixed(4)}, among ${eligible.length} eligible.`;

  return {
    taskCategory,
    chosen: best,
    usedSafeDefault: false,
    reason,
    consideredCount: forCategory.length,
    eligibleCount: eligible.length,
  };
}
