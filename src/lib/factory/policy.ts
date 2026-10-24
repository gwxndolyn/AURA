/**
 * Autonomy and approval policy for the product factory. Enforced in code by
 * the factory services before any consequential action — never by prompt.
 *
 * Production-impacting actions ALWAYS require a human approval, at every
 * autonomy level (there is deliberately no setting that removes it).
 */

export const AUTONOMY_LEVELS = ["SUGGEST", "SUPERVISED", "BOUNDED", "CONTINUOUS"] as const;
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_HELP: Record<Autonomy, string> = {
  SUGGEST: "Analyze, plan and recommend. Nothing is executed or changed without your approval.",
  SUPERVISED: "Runs approved tasks in the isolated workspace. Asks before publishing changes or any consequential action.",
  BOUNDED: "Runs ready tasks within scope, budget and retry limits; local commits are automatic. Asks before publishing or anything production-impacting.",
  CONTINUOUS: "Also reacts to configured repository events with bounded workflows. Publishing and production still follow approvals.",
};

export const ACTION_CLASSES = ["analysis", "local_execution", "local_commit", "external_publication", "infrastructure", "production"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const ACTION_CLASS_HELP: Record<ActionClass, string> = {
  analysis: "Read-only planning and analysis.",
  local_execution: "Agents edit an isolated working copy and run tests in the sandbox. Reversible.",
  local_commit: "Commit verified changes to a branch in AURA's local repository. Reversible.",
  external_publication: "Push a branch or open a pull/merge request on GitHub/GitLab.",
  infrastructure: "Change deployment or infrastructure configuration.",
  production: "Deploy to, or otherwise affect, production.",
};

/** Does this action need a human decision under this autonomy level? */
export function needsApproval(autonomy: Autonomy, action: ActionClass): boolean {
  if (action === "production" || action === "infrastructure") return true;
  if (action === "external_publication") return true;
  if (action === "analysis") return false;
  if (autonomy === "SUGGEST") return true; // execution and commits wait for a person
  if (action === "local_commit") return autonomy === "SUPERVISED";
  return false; // local_execution under SUPERVISED+ (scope approval is the gate)
}

/** Can the engine dispatch work on its own at this level (after scope approval)? */
export function mayAutoDispatch(autonomy: Autonomy): boolean {
  return autonomy !== "SUGGEST";
}

export interface Limits {
  maxRepairs: number; // bounded repair rounds per task (mission maxRepairs)
  maxParallel: number; // concurrently running tasks per product
  budgetUsd: number; // per task model budget
  maxAttempts: number; // dispatch attempts per task before it is BLOCKED for a person
  projectBudgetUsd: number; // estimated model spend across all runs of this product; dispatch stops at the limit
}

export const DEFAULT_LIMITS: Limits = { maxRepairs: 2, maxParallel: 2, budgetUsd: 1, maxAttempts: 2, projectBudgetUsd: 25 };
export const LIMIT_BOUNDS: Record<keyof Limits, [number, number]> = { maxRepairs: [0, 5], maxParallel: [1, 4], budgetUsd: [0.01, 10], maxAttempts: [1, 3], projectBudgetUsd: [0.1, 500] };
/** Share of the product budget at which a usage alert is raised. */
export const BUDGET_ALERT_RATIO = 0.8;

export function clampLimits(input: Partial<Limits>): Limits {
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(LIMIT_BOUNDS) as (keyof Limits)[]) {
    const v = input[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      const [lo, hi] = LIMIT_BOUNDS[k];
      out[k] = k === "budgetUsd" || k === "projectBudgetUsd" ? Math.min(Math.max(v, lo), hi) : Math.min(Math.max(Math.round(v), lo), hi);
    }
  }
  return out;
}
