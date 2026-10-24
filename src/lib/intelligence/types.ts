/**
 * Core type definitions for the AI Engineering Intelligence layer.
 * Pure types only — no runtime deps — so every other module can import freely.
 */
import type { FailureCategory } from "./failures";

/** A single evaluation metric (name + numeric value + optional unit). */
export interface EvalMetric {
  name: string;
  value: number;
  unit?: string;
}

/** The verdict of one evaluator against one case output. */
export interface EvaluatorVerdict {
  evaluator: string; // which evaluator produced this (schema|assertion|policy|test|model)
  pass: boolean;
  score: number; // 0..1
  detail: string;
  failureCategory?: FailureCategory;
}

/** The outcome of evaluating one dataset case. */
export interface CaseResult {
  caseId: string;
  /** Skipped cases (e.g. Docker unavailable, budget stop) are excluded from all rates. */
  skipped?: boolean;
  skipReason?: string;
  pass: boolean;
  score: number; // 0..1 aggregate across evaluators
  verdicts: EvaluatorVerdict[];
  failureCategory?: FailureCategory;
  // Operational telemetry (never secrets / raw reasoning).
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  latencyMs?: number;
  // The validated/summarized output actually produced (safe to persist).
  outputSummary?: string;
}

/** Expected behavior / acceptance criteria for a dataset case. */
export interface CaseExpectation {
  /** JSON-shape expectation: the output must be parseable + match these keys/types. */
  schema?: Record<string, "string" | "number" | "boolean" | "array" | "object">;
  /** Deterministic assertions over the (parsed) output. All must hold. */
  assertions?: CaseAssertion[];
  /** Policy expectations enforced in code (not by the model). */
  policy?: {
    /** The case must be refused/rejected by the agent (unsafe task). */
    mustRefuse?: boolean;
    /** The case must be escalated to a human. */
    mustEscalate?: boolean;
    /** A tool request in this case must be denied by permissions. */
    toolMustBeDenied?: { agentKey: string; tool: string };
    /** Output must NOT contain any of these (e.g. injected instruction effects, secrets). */
    mustNotContain?: string[];
  };
  /**
   * The run is EXPECTED to fail with exactly this category and be handled
   * gracefully (no crash) — e.g. a budget stop, a tool timeout, a denied tool.
   */
  expectedFailure?: FailureCategory;
}

/**
 * How the evaluation harness drives a case. "model" calls the agent through
 * complete(); the others exercise a REAL control path in code (permissions,
 * engine budget, tool timeout/validation, Docker sandbox) — never a mock.
 */
export type CaseHarness =
  | { type: "model" }
  | { type: "tool"; tool: string; behavior: "ok" | "malformed" | "timeout" | "error"; timeoutMs?: number }
  | { type: "injection"; injectedTool: string }
  | { type: "budget"; caseBudgetUsd: number }
  | { type: "sandbox-repair"; injectBug?: boolean; maxAttempts?: number };

export interface CaseAssertion {
  kind: "equals" | "includes" | "matches" | "gte" | "lte" | "arrayMinLength" | "isOneOf";
  /** Dot-path into the parsed output object, or "" for the whole string output. */
  path: string;
  value: unknown;
  describe?: string;
}

/** A single dataset case. Deterministic fixtures preferred. */
export interface DatasetCase {
  id: string;
  description: string;
  /** Difficulty: normal path vs an adversarial / edge case. */
  kind: "normal" | "difficult";
  /** The objective handed to the agent. */
  objective: string;
  /** Extra context (may include deliberately untrusted content for injection tests). */
  context?: string;
  /** The simulator `kind` hint, so offline fixtures are deterministic. */
  simKind?: string;
  /** Inputs the task requires; if absent from context the agent must escalate. */
  requiredInputs?: string[];
  /** Defaults to { type: "model" }. */
  harness?: CaseHarness;
  /** Tags used to derive scorecard dimensions (security, injection, escalation, handoff, conflict). */
  tags?: ("security" | "injection" | "escalation" | "handoff" | "conflict" | "repair" | "unsafe")[];
  expectation: CaseExpectation;
}

/** A versioned dataset for one agent category. */
export interface EvalDataset {
  id: string; // e.g. "product-manager"
  version: string; // semver-ish, bump on change
  agentKey: string;
  description: string;
  cases: DatasetCase[];
}

/** Aggregate result of evaluating a whole dataset in one run. */
export interface EvaluationRun {
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
  cases: CaseResult[];
  // Aggregates (skipped cases excluded from total/passed/failed and all rates)
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  p50LatencyMs: number | null; // null when < 5 evaluated cases
  p95LatencyMs: number | null;
  passRate: number; // passed/total
  avgScore: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  costPerPass: number | null; // null when 0 passes
  avgLatencyMs: number;
  failureCounts: { category: FailureCategory; count: number }[];
  startedAt: string;
  finishedAt: string;
}
