/**
 * Standardized failure taxonomy for AI engineering runs + a best-effort
 * classifier. Pure, deterministic, dependency-free so it is trivially testable
 * and can run anywhere (evaluators, orchestrator, API).
 *
 * The classifier maps an observed error/signal to a single category using
 * explicit, ordered evidence rules. When no rule matches we return
 * "unknown_failure" rather than guessing — a suspected cause is never recorded
 * as proven (see docs/ai-engineering/evaluation-and-testing.md).
 */

export const FAILURE_CATEGORIES = [
  "invalid_input",
  "invalid_structured_output",
  "model_refusal",
  "model_timeout",
  "provider_error",
  "tool_argument_error",
  "tool_execution_error",
  "tool_timeout",
  "invalid_tool_output",
  "authorization_denied",
  "retrieval_failure",
  "context_overflow",
  "budget_exceeded",
  "agent_handoff_failure",
  "test_failure",
  "code_generation_failure",
  "sandbox_failure",
  "security_policy_violation",
  "evaluation_failure",
  "unknown_failure",
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** Human-readable labels + remediation hint per category (shown in the UI). */
export const FAILURE_META: Record<
  FailureCategory,
  { label: string; hint: string }
> = {
  invalid_input: { label: "Invalid input", hint: "Validate/repair input before the model call; check the input fixture." },
  invalid_structured_output: { label: "Invalid structured output", hint: "Inspect the output schema and structured-output configuration." },
  model_refusal: { label: "Model refusal", hint: "Review the prompt for ambiguity; confirm the task is legitimate." },
  model_timeout: { label: "Model timeout", hint: "Lower context size / tier, or raise the timeout; check provider latency." },
  provider_error: { label: "Provider error", hint: "Check provider status; verify the fallback provider path." },
  tool_argument_error: { label: "Tool argument error", hint: "Tighten the tool schema and validate args inside the impl." },
  tool_execution_error: { label: "Tool execution error", hint: "Inspect tool reliability, timeouts, and idempotency." },
  tool_timeout: { label: "Tool timeout", hint: "Check the tool's latency and timeout bound; make it idempotent so it can be retried safely." },
  invalid_tool_output: { label: "Invalid tool output", hint: "Tighten the tool's output contract and validate it before use — never trust raw tool output." },
  authorization_denied: { label: "Authorization denied", hint: "Expected for unauthorized attempts — confirm least-privilege allowlist." },
  retrieval_failure: { label: "Retrieval failure", hint: "Check retrieval relevance and access scoping." },
  context_overflow: { label: "Context overflow", hint: "Reduce context; improve retrieval relevance and truncation." },
  budget_exceeded: { label: "Budget exceeded", hint: "Review per-task budget and retry policy; batch or route cheaper." },
  agent_handoff_failure: { label: "Agent handoff failure", hint: "Check handoff message schema and missing-context between agents." },
  test_failure: { label: "Test failure", hint: "Inspect code generation and QA feedback quality." },
  code_generation_failure: { label: "Code generation failure", hint: "Review the codegen template/prompt and build-check step." },
  sandbox_failure: { label: "Sandbox failure", hint: "Check Docker availability and sandbox resource limits." },
  security_policy_violation: { label: "Security policy violation", hint: "A control fired — confirm it was correct; investigate the attempt." },
  evaluation_failure: { label: "Evaluation failure", hint: "The evaluator itself failed — check the dataset/assertion." },
  unknown_failure: { label: "Unknown failure", hint: "Insufficient evidence to classify — add signals/logging." },
};

export interface ClassifyInput {
  /** Error message / stderr / reason, if any. */
  error?: string;
  /** Explicit signals from the run (preferred over string matching). */
  signals?: {
    timedOut?: boolean;
    overBudget?: boolean;
    permissionDenied?: boolean;
    schemaInvalid?: boolean;
    testsFailed?: boolean;
    toolFailed?: boolean;
    toolTimedOut?: boolean;
    toolOutputInvalid?: boolean;
    sandboxUnavailable?: boolean;
    refused?: boolean;
    providerError?: boolean;
    securityViolation?: boolean;
    handoffFailed?: boolean;
    retrievalFailed?: boolean;
    contextOverflow?: boolean;
  };
}

/**
 * Classify a failure. Signals take precedence over string matching because they
 * are explicit evidence. Returns "unknown_failure" when nothing matches.
 */
export function classifyFailure(input: ClassifyInput): FailureCategory {
  const s = input.signals ?? {};
  // Ordered by specificity: security + authorization first (never masked).
  if (s.securityViolation) return "security_policy_violation";
  if (s.permissionDenied) return "authorization_denied";
  if (s.overBudget) return "budget_exceeded";
  if (s.schemaInvalid) return "invalid_structured_output";
  if (s.refused) return "model_refusal";
  if (s.toolTimedOut) return "tool_timeout";
  if (s.toolOutputInvalid) return "invalid_tool_output";
  if (s.timedOut) return "model_timeout";
  if (s.sandboxUnavailable) return "sandbox_failure";
  if (s.toolFailed) return "tool_execution_error";
  if (s.testsFailed) return "test_failure";
  if (s.handoffFailed) return "agent_handoff_failure";
  if (s.retrievalFailed) return "retrieval_failure";
  if (s.contextOverflow) return "context_overflow";
  if (s.providerError) return "provider_error";

  const e = (input.error ?? "").toLowerCase();
  if (!e) return "unknown_failure";
  // String heuristics — explicit, ordered, documented. These are hints, not proof.
  if (/\b(unauthoriz|forbidden|permission denied|not permitted|requires .* role)\b/.test(e)) return "authorization_denied";
  if (/\b(security|injection|exfiltrat|sandbox escape)\b/.test(e)) return "security_policy_violation";
  if (/\bbudget\b/.test(e)) return "budget_exceeded";
  if (/\b(invalid json|schema|zoderror|unexpected token|failed to parse)\b/.test(e)) return "invalid_structured_output";
  if (/\b(refus|cannot assist|i can('|no)t help)\b/.test(e)) return "model_refusal";
  if (/\btool\b.*\b(timeout|timed out)\b/.test(e)) return "tool_timeout";
  if (/\b(timeout|timed out|etimedout|deadline exceeded)\b/.test(e)) return "model_timeout";
  if (/\b(context (length|window|overflow)|too many tokens|maximum context)\b/.test(e)) return "context_overflow";
  if (/\b(docker|container|no such image)\b/.test(e)) return "sandbox_failure";
  if (/\b(tool argument|invalid argument|missing argument|bad request)\b/.test(e)) return "tool_argument_error";
  if (/\b(tool .*failed|tool execution)\b/.test(e)) return "tool_execution_error";
  if (/\b(test[s]? failed|assertion|expected .* received)\b/.test(e)) return "test_failure";
  if (/\b(handoff|handover)\b/.test(e)) return "agent_handoff_failure";
  if (/\b(retriev|not found in memory|no relevant context)\b/.test(e)) return "retrieval_failure";
  if (/\b(provider|rate limit|429|5\d\d|api error)\b/.test(e)) return "provider_error";
  if (/\b(syntax error|compile|build failed)\b/.test(e)) return "code_generation_failure";
  return "unknown_failure";
}

/** Group failure categories into counts, most frequent first. */
export function groupFailures(categories: FailureCategory[]): { category: FailureCategory; count: number }[] {
  const counts = new Map<FailureCategory, number>();
  for (const c of categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/**
 * Produce evidence-based root-cause HYPOTHESES for a group of failures. These
 * are explicitly labeled as hypotheses with a confidence and the evidence
 * (sample size) behind them — never asserted as proven.
 */
export interface RootCauseHypothesis {
  category: FailureCategory;
  count: number;
  share: number; // 0..1 of total failures
  hypothesis: string;
  confidence: "low" | "medium" | "high";
  evidence: string;
}

export function rootCauseHypotheses(categories: FailureCategory[]): RootCauseHypothesis[] {
  const total = categories.length;
  if (total === 0) return [];
  const grouped = groupFailures(categories);
  return grouped.map(({ category, count }) => {
    const share = count / total;
    // Confidence scales with absolute count AND share — small samples stay "low".
    let confidence: RootCauseHypothesis["confidence"] = "low";
    if (count >= 10 && share >= 0.5) confidence = "high";
    else if (count >= 5 && share >= 0.3) confidence = "medium";
    return {
      category,
      count,
      share,
      hypothesis: FAILURE_META[category].hint,
      confidence,
      evidence: `${count}/${total} failures (${Math.round(share * 100)}%) classified ${category}`,
    };
  });
}
