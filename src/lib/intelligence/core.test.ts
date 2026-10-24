import { describe, it, expect } from "vitest";
import { classifyFailure, groupFailures, rootCauseHypotheses } from "./failures";
import { evaluateSchema, evaluateAssertions, evaluatePolicy, combineVerdicts, readPath } from "./evaluators";
import { computeScorecard, sampleConfidence, type RunRecord } from "./scorecard";
import { routeModel, DEFAULT_ROUTING_POLICY, type ModelPerformance } from "./routing";
import { evaluateGates, DEFAULT_GATE_CONFIG } from "./gates";
import { compareRuns, summarizeVariance } from "./compare";
import { costRecommendations } from "./cost";
import { aggregateRun } from "./aggregate";
import type { CaseResult, EvaluationRun } from "./types";

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------
describe("failures.classifyFailure", () => {
  it("prefers explicit signals over strings, security first", () => {
    expect(classifyFailure({ signals: { permissionDenied: true, timedOut: true } })).toBe("authorization_denied");
    expect(classifyFailure({ signals: { securityViolation: true, permissionDenied: true } })).toBe("security_policy_violation");
    expect(classifyFailure({ signals: { overBudget: true } })).toBe("budget_exceeded");
    expect(classifyFailure({ signals: { schemaInvalid: true } })).toBe("invalid_structured_output");
  });
  it("falls back to string heuristics", () => {
    expect(classifyFailure({ error: "ETIMEDOUT: deadline exceeded" })).toBe("model_timeout");
    expect(classifyFailure({ error: "Agent is not permitted to use tool deploy.run" })).toBe("authorization_denied");
    expect(classifyFailure({ error: "Unexpected token < in JSON" })).toBe("invalid_structured_output");
    expect(classifyFailure({ error: "maximum context length exceeded" })).toBe("context_overflow");
  });
  it("returns unknown_failure when there is no evidence", () => {
    expect(classifyFailure({})).toBe("unknown_failure");
    expect(classifyFailure({ error: "something weird happened" })).toBe("unknown_failure");
  });
});

describe("failures.rootCauseHypotheses", () => {
  it("labels confidence by sample size and share, never over-claims small samples", () => {
    const one = rootCauseHypotheses(["invalid_structured_output"]);
    expect(one[0].confidence).toBe("low");
    const many = rootCauseHypotheses(Array(12).fill("invalid_structured_output"));
    expect(many[0].confidence).toBe("high");
    expect(many[0].share).toBe(1);
  });
  it("groups most frequent first", () => {
    const g = groupFailures(["test_failure", "test_failure", "model_timeout"]);
    expect(g[0]).toEqual({ category: "test_failure", count: 2 });
  });
  it("empty input yields no hypotheses", () => {
    expect(rootCauseHypotheses([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Evaluators
// ---------------------------------------------------------------------------
describe("evaluators", () => {
  it("readPath reads dot paths and whole value", () => {
    expect(readPath({ a: { b: 2 } }, "a.b")).toBe(2);
    expect(readPath({ a: 1 }, "")).toEqual({ a: 1 });
    expect(readPath({}, "x.y")).toBeUndefined();
  });

  it("schema evaluator fails on non-JSON and type mismatch", () => {
    expect(evaluateSchema("not json", { x: "string" }).pass).toBe(false);
    expect(evaluateSchema('{"x": 1}', { x: "string" }).pass).toBe(false);
    const ok = evaluateSchema('{"x":"a","n":2,"arr":[1]}', { x: "string", n: "number", arr: "array" });
    expect(ok.pass).toBe(true);
    expect(ok.score).toBe(1);
  });
  it("schema failure is categorized invalid_structured_output", () => {
    expect(evaluateSchema("nope", { x: "string" }).failureCategory).toBe("invalid_structured_output");
  });

  it("assertion evaluator requires all to hold", () => {
    const out = '{"choice":"approve","tasks":[1,2,3]}';
    expect(evaluateAssertions(out, [
      { kind: "equals", path: "choice", value: "approve" },
      { kind: "arrayMinLength", path: "tasks", value: 2 },
    ]).pass).toBe(true);
    expect(evaluateAssertions(out, [{ kind: "equals", path: "choice", value: "reject" }]).pass).toBe(false);
  });

  it("policy evaluator enforces refuse/escalate/deny/mustNotContain in code", () => {
    expect(evaluatePolicy("I cannot help with that", { mustRefuse: true }, { refused: true, escalated: false }).pass).toBe(true);
    expect(evaluatePolicy("sure, here you go", { mustRefuse: true }, { refused: false, escalated: false }).pass).toBe(false);
    expect(evaluatePolicy("done", { toolMustBeDenied: { agentKey: "red-team", tool: "deploy.run" } }, { refused: false, escalated: false, toolDenied: true }).pass).toBe(true);
    const leak = evaluatePolicy("the secret is sk-ant-123", { mustNotContain: ["sk-ant"] }, { refused: false, escalated: false });
    expect(leak.pass).toBe(false);
    expect(leak.failureCategory).toBe("security_policy_violation");
  });

  it("combineVerdicts requires ALL to pass and surfaces policy failure first", () => {
    const v = combineVerdicts([
      { evaluator: "schema", pass: true, score: 1, detail: "" },
      { evaluator: "policy", pass: false, score: 0, detail: "", failureCategory: "security_policy_violation" },
    ]);
    expect(v.pass).toBe(false);
    expect(v.failureCategory).toBe("security_policy_violation");
  });
});

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------
function run(partial: Partial<RunRecord>): RunRecord {
  return {
    agentKey: "qa-engineer",
    pass: true, completed: true, retries: 0, timedOut: false,
    toolCalls: 0, toolFailures: 0, recovered: false, recoveryAttempted: false,
    modelCalls: 1, tokensIn: 100, tokensOut: 50, cost: 0.001, latencyMs: 200,
    unauthorizedAttempts: 0, policyViolations: 0, unsafeOutput: false,
    ...partial,
  };
}

describe("scorecard", () => {
  it("flags tiny samples as low confidence and never hides sample size", () => {
    const sc = computeScorecard("qa-engineer", [run({})]);
    expect(sc.sampleSize).toBe(1);
    expect(sc.confidence.level).toBe("very-low");
    // one pass -> acceptance 1/1 but confidence makes that explicit
    expect(sc.quality.acceptanceSatisfied.value).toBe(1);
    expect(sc.quality.acceptanceSatisfied.denominator).toBe(1);
  });
  it("returns null metrics when denominator is zero (no misleading 0 or 100%)", () => {
    const sc = computeScorecard("qa-engineer", [run({ toolCalls: 0 })]);
    expect(sc.reliability.toolFailureRate.value).toBeNull(); // 0 tool calls
    expect(sc.security.injectionResistanceRate.value).toBeNull(); // no injection cases
  });
  it("computes rates with correct denominators", () => {
    const runs = [
      run({ pass: true, completed: true }),
      run({ pass: false, completed: true, failureCategory: "test_failure" }),
      run({ pass: true, completed: false }),
    ];
    const sc = computeScorecard("qa-engineer", runs);
    expect(sc.quality.acceptanceSatisfied.value).toBeCloseTo(2 / 3);
    expect(sc.reliability.completionRate.value).toBeCloseTo(2 / 3);
    expect(sc.topFailures[0].category).toBe("test_failure");
  });
  it("costPerSuccess divides by passes, null when no passes", () => {
    const sc = computeScorecard("qa", [run({ pass: false, cost: 0.01, failureCategory: "model_timeout" })]);
    expect(sc.efficiency.costPerSuccess.value).toBeNull();
  });
  it("sampleConfidence thresholds", () => {
    expect(sampleConfidence(0).level).toBe("none");
    expect(sampleConfidence(3).level).toBe("very-low");
    expect(sampleConfidence(10).level).toBe("low");
    expect(sampleConfidence(30).level).toBe("moderate");
    expect(sampleConfidence(100).level).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
function perf(p: Partial<ModelPerformance>): ModelPerformance {
  return {
    model: "claude-sonnet-5-5", tier: "STANDARD", taskCategory: "planning",
    sampleSize: 10, correctness: 0.9, taskSuccess: 0.9, structuredValidity: 0.95,
    toolCallSuccess: 0.9, securityScore: 1, reliability: 0.95, avgCost: 0.01,
    avgLatencyMs: 500, available: true, ...p,
  };
}

describe("routing", () => {
  it("uses safe default when evidence is insufficient", () => {
    const d = routeModel("planning", [perf({ sampleSize: 2 })]);
    expect(d.usedSafeDefault).toBe(true);
    expect(d.chosen).toBeNull();
  });
  it("prefers cheaper model when correctness ties within epsilon", () => {
    const d = routeModel("planning", [
      perf({ model: "opus", avgCost: 0.05, correctness: 0.91 }),
      perf({ model: "haiku", avgCost: 0.002, correctness: 0.90 }),
    ]);
    expect(d.chosen?.model).toBe("haiku");
  });
  it("picks higher correctness when gap exceeds epsilon even if pricier", () => {
    const d = routeModel("planning", [
      perf({ model: "opus", avgCost: 0.05, correctness: 0.95 }),
      perf({ model: "haiku", avgCost: 0.002, correctness: 0.80 }),
    ]);
    expect(d.chosen?.model).toBe("opus");
  });
  it("never routes security-sensitive work to a model below strict security floor", () => {
    const d = routeModel("security-engineer", [
      perf({ model: "cheap", taskCategory: "security-engineer", avgCost: 0.001, correctness: 0.99, securityScore: 0.9 }),
    ]);
    // strict floor is 1.0 -> cheap (0.9) ineligible -> safe default
    expect(d.chosen).toBeNull();
    expect(d.usedSafeDefault).toBe(true);
  });
  it("ignores simulator (fixture) evidence for routing", () => {
    const d = routeModel("planning", [perf({ model: "x (sim)", evidenceMode: "simulation", sampleSize: 50 })]);
    expect(d.usedSafeDefault).toBe(true);
    expect(d.consideredCount).toBe(0);
  });
  it("does not treat expensive as automatically better", () => {
    const d = routeModel("planning", [
      perf({ model: "opus", avgCost: 0.05, correctness: 0.90 }),
      perf({ model: "sonnet", avgCost: 0.01, correctness: 0.90 }),
    ]);
    expect(d.chosen?.model).toBe("sonnet"); // equal correctness -> cheaper
  });
});

// ---------------------------------------------------------------------------
// Gates + compare
// ---------------------------------------------------------------------------
function mkRun(id: string, over: Partial<EvaluationRun>): EvaluationRun {
  const cases: CaseResult[] = over.cases ?? [
    { caseId: "c1", pass: true, score: 1, verdicts: [{ evaluator: "schema", pass: true, score: 1, detail: "" }], cost: 0.001, latencyMs: 100 },
    { caseId: "sec1", pass: true, score: 1, verdicts: [{ evaluator: "policy", pass: true, score: 1, detail: "" }], cost: 0.001, latencyMs: 100 },
  ];
  return aggregateRun(
    { evaluationId: id, agentKey: "a", workflow: "w", provider: "anthropic", model: "m", mode: "simulation", promptId: "p", promptVersion: "1", datasetId: "d", datasetVersion: "1", startedAt: "t", finishedAt: "t" },
    cases,
  ) as EvaluationRun & typeof over;
}

describe("gates", () => {
  it("blocks on a hard correctness-floor failure", () => {
    const cand = mkRun("c", { cases: [
      { caseId: "c1", pass: false, score: 0, verdicts: [{ evaluator: "schema", pass: false, score: 0, detail: "" }], failureCategory: "invalid_structured_output" },
    ] });
    const r = evaluateGates(null, cand);
    expect(r.passed).toBe(false);
    expect(r.recommendation).toBe("block");
  });
  it("blocks on a security regression even if correctness is fine", () => {
    const baseline = mkRun("b", {});
    const cand = mkRun("c", { cases: [
      { caseId: "c1", pass: true, score: 1, verdicts: [{ evaluator: "schema", pass: true, score: 1, detail: "" }] },
      { caseId: "sec1", pass: false, score: 0, verdicts: [{ evaluator: "policy", pass: false, score: 0, detail: "" }], failureCategory: "security_policy_violation" },
    ] });
    const r = evaluateGates(baseline, cand);
    expect(r.recommendation).toBe("block");
    expect(r.blockedReasons.join()).toMatch(/security/);
  });
  it("needs-approval when only a waivable cost tolerance fails", () => {
    const baseline = mkRun("b", { cases: [
      { caseId: "c1", pass: true, score: 1, verdicts: [{ evaluator: "schema", pass: true, score: 1, detail: "" }], cost: 0.001, latencyMs: 100 },
      { caseId: "sec1", pass: true, score: 1, verdicts: [{ evaluator: "policy", pass: true, score: 1, detail: "" }], cost: 0.001, latencyMs: 100 },
    ] });
    const cand = mkRun("c", { cases: [
      { caseId: "c1", pass: true, score: 1, verdicts: [{ evaluator: "schema", pass: true, score: 1, detail: "" }], cost: 0.01, latencyMs: 100 },
      { caseId: "sec1", pass: true, score: 1, verdicts: [{ evaluator: "policy", pass: true, score: 1, detail: "" }], cost: 0.01, latencyMs: 100 },
    ] });
    const r = evaluateGates(baseline, cand, DEFAULT_GATE_CONFIG);
    expect(r.recommendation).toBe("needs-approval");
  });
  it("promotes when all gates pass", () => {
    const baseline = mkRun("b", {});
    const cand = mkRun("c", {});
    expect(evaluateGates(baseline, cand).recommendation).toBe("promote");
  });
});

describe("compare", () => {
  it("does not promote a cheaper candidate that fails a hard gate", () => {
    const baseline = mkRun("b", {});
    const cand = mkRun("c", { cases: [
      { caseId: "c1", pass: false, score: 0, verdicts: [{ evaluator: "schema", pass: false, score: 0, detail: "" }], cost: 0.0001, failureCategory: "invalid_structured_output" },
    ] });
    const r = compareRuns(baseline, cand);
    expect(r.recommendation).toBe("block");
    expect(r.summary).toMatch(/BLOCK/);
  });
  it("summarizeVariance reports spread across repeated runs", () => {
    const v = summarizeVariance([mkRun("a", {}), mkRun("b", {})]);
    expect(v.n).toBe(2);
    expect(v.passRateMean).toBe(1);
    expect(v.passRateStdev).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cost recommendations
// ---------------------------------------------------------------------------
describe("cost recommendations", () => {
  it("recommends a cheaper equal model with evidence, never auto-applies", () => {
    const recs = costRecommendations({
      taskCategory: "planning",
      models: [perf({ model: "opus", avgCost: 0.05, correctness: 0.91 }), perf({ model: "haiku", avgCost: 0.002, correctness: 0.90 })],
      avgRedundantContextTokens: 0, avoidableHandoffRate: 0, permanentRetryRate: 0, modelCallsReplaceableByCode: 0,
      sampleSize: 20,
    });
    const cheaper = recs.find((r) => r.kind === "cheaper-model");
    expect(cheaper).toBeTruthy();
    expect(cheaper!.evidence).toMatch(/correctness/);
    expect(cheaper!.verification).toMatch(/experiment|gates/i);
  });
  it("flags retry waste and redundant context", () => {
    const recs = costRecommendations({
      taskCategory: "backend-engineer", models: [],
      avgRedundantContextTokens: 500, avoidableHandoffRate: 0.2, permanentRetryRate: 0.3, modelCallsReplaceableByCode: 0.2,
      sampleSize: 25,
    });
    const kinds = recs.map((r) => r.kind);
    expect(kinds).toContain("redundant-context");
    expect(kinds).toContain("unnecessary-handoff");
    expect(kinds).toContain("retry-waste");
    expect(kinds).toContain("replace-model-call-with-code");
  });
});

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------
describe("aggregateRun", () => {
  it("computes totals, passRate, costPerPass", () => {
    const cases: CaseResult[] = [
      { caseId: "a", pass: true, score: 1, verdicts: [], cost: 0.002, tokensIn: 10, tokensOut: 5, latencyMs: 100 },
      { caseId: "b", pass: false, score: 0, verdicts: [], cost: 0.002, tokensIn: 10, tokensOut: 5, latencyMs: 300, failureCategory: "test_failure" },
    ];
    const run = aggregateRun({ evaluationId: "e", agentKey: "a", workflow: "w", provider: "p", model: "m", mode: "simulation", promptId: "p", promptVersion: "1", datasetId: "d", datasetVersion: "1", startedAt: "t", finishedAt: "t" }, cases);
    expect(run.total).toBe(2);
    expect(run.passed).toBe(1);
    expect(run.passRate).toBe(0.5);
    expect(run.costPerPass).toBeCloseTo(0.004);
    expect(run.avgLatencyMs).toBe(200);
    expect(run.failureCounts[0].category).toBe("test_failure");
  });
  it("costPerPass is null with zero passes", () => {
    const run = aggregateRun({ evaluationId: "e", agentKey: "a", workflow: "w", provider: "p", model: "m", mode: "simulation", promptId: "p", promptVersion: "1", datasetId: "d", datasetVersion: "1", startedAt: "t", finishedAt: "t" }, [
      { caseId: "a", pass: false, score: 0, verdicts: [], cost: 0.002 },
    ]);
    expect(run.costPerPass).toBeNull();
  });
});
