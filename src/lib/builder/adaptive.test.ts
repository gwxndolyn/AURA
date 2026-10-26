/** Adaptive execution policy (pure): classification, strategy, verification, tools, model routing, feedback controller, collaboration. */
import { describe, it, expect } from "vitest";
import { classifyTask, chooseStrategy, verificationRequirements, verificationStatus, toolPlan, routeModel, adjust, collaborationValue, type TaskEvidence, type Signals, DEFAULT_MODEL_POLICY } from "./adaptive";

const base: TaskEvidence = { key: "T1", kind: "FRONTEND", level: "TASK", title: "Fix the label of the amount field", description: "The amount input has no label.", acceptance: ["The amount input has a visible label 'Amount'"], files: ["public/app.js"], dependsOn: [], plannedRisk: "LOW", assessedRisk: "LOW", riskReasons: [], repoFiles: ["public/app.js", "src/server.js"], dependents: [], openDefects: [], priorRuns: [], history: [], externalApis: [] };
const sig: Signals = { attempt: 1, maxAttempts: 3, adjustmentsSoFar: [], recurringDefect: false, identicalTree: false, revertedFiles: [], scopeGrowth: 1, unprovenCriteria: 0, reviewerConflict: false, categories: ["code"], budgetLeftUsd: 1 };

describe("classification", () => {
  it("a small, clear UI defect takes the fast path with evidence and high confidence", () => {
    const c = classifyTask(base);
    expect(c.category.value).toBe("debugging"); // "Fix …" describes a defect
    expect(c.fastPath).toBe(true);
    expect(c.scope.value).toBe("component");
    expect(c.familiarity.value).toBe("known");
    expect(c.confidence).toBeGreaterThanOrEqual(0.9);
    expect(c.category.evidence.length).toBeGreaterThan(0);
  });
  it("authorization changes are security tasks with deep verification", () => {
    const c = classifyTask({ ...base, kind: "BACKEND", title: "Only admins may delete projects", description: "Add role checks to DELETE /api/projects/:id", acceptance: ["Non-admins get 403"], assessedRisk: "HIGH", riskReasons: ["authentication/authorization"], files: ["src/routes/projects.js"] });
    expect(c.category.value).toBe("security");
    expect(c.verificationDepth.value).toBe("deep");
    expect(c.fastPath).toBe(false);
  });
  it("missing acceptance criteria are a blocking ambiguity; vague targets raise uncertainty", () => {
    expect(classifyTask({ ...base, title: "Improve the dashboard", description: "make it better", acceptance: [] }).ambiguity.blocking).toBe(true);
    const v = classifyTask({ ...base, title: "Improve performance", description: "optimize it", acceptance: ["feels faster"] });
    expect(v.uncertainty.value).toBe("high");
    expect(v.ambiguity.blocking).toBe(false);
  });
  it("an external API not yet used in the repo needs research; recurring failures raise complexity", () => {
    const r = classifyTask({ ...base, kind: "BACKEND", title: "Send receipts via Resend", description: "Call the Resend API", acceptance: ["POST /api/receipts sends an email"], files: ["src/routes/receipts.js"], externalApis: ["resend"] });
    expect(r.research.value).toBe(true);
    expect(r.category.value).toBe("integration");
    expect(classifyTask({ ...base, kind: "BACKEND", title: "Add totals", description: "totals endpoint", priorRuns: [{ status: "FAILED", attempts: 3, stopReason: "repeated_failure" }] }).complexity.value).toBe("high");
  });
});

describe("strategy selection", () => {
  const ctx = { owner: "frontend-engineer", reviewers: ["qa-engineer", "reviewer"], browser: true, parallelWorth: false };
  it("chooses the least complicated sufficient strategy", () => {
    expect(chooseStrategy(classifyTask({ ...base, title: "Show the total", description: "Render the monthly total", acceptance: ["Total shows"] }), ctx).strategy).toBe("direct");
    expect(chooseStrategy(classifyTask({ ...base, openDefects: [{ category: "code", occurrences: 1, failingTests: ["x"] }] }), ctx).strategy).toBe("test_driven_repair");
    expect(chooseStrategy(classifyTask({ ...base, assessedRisk: "HIGH", riskReasons: ["payments"] }), ctx).strategy).toBe("high_assurance");
    expect(chooseStrategy(classifyTask({ ...base, title: "Add totals", description: "totals", externalApis: ["stripe"], files: ["src/pay.js"] }), ctx).strategy).toBe("investigate_then_execute");
    expect(chooseStrategy(classifyTask({ ...base, title: "Add totals", description: "x", dependsOn: ["T0"] }), ctx).strategy).toBe("sequential_handoff");
  });
  it("plans carry dependencies, gates and the TDD precondition", () => {
    const p = chooseStrategy(classifyTask({ ...base, openDefects: [{ category: "code", occurrences: 1, failingTests: ["x"] }] }), ctx);
    expect(p.steps.map((s) => s.key)).toEqual(["reproduce", "implement", "verify", "browser", "review:qa-engineer", "review:reviewer"]);
    expect(p.steps.find((s) => s.key === "implement")!.dependsOn).toEqual(["reproduce"]);
    expect(p.steps.find((s) => s.key === "implement")!.gate).toMatch(/reproducing test/);
    expect(p.steps.filter((s) => s.kind === "review").every((s) => s.parallel)).toBe(true);
  });
  it("honours a strategy pinned by project policy", () => {
    expect(chooseStrategy(classifyTask(base), { ...ctx, pinned: "high_assurance" }).strategy).toBe("high_assurance");
  });
});

describe("verification depth", () => {
  it("risk adds checks; project policy adds checks; nothing is lowered", () => {
    const low = verificationRequirements(classifyTask(base), { ui: true, schemaChange: false }).map((r) => r.id);
    expect(low).toEqual(expect.arrayContaining(["unit_tests", "code_review", "full_regression", "browser_journeys"]));
    expect(low).not.toContain("security_review");
    const high = verificationRequirements(classifyTask({ ...base, assessedRisk: "HIGH", riskReasons: ["authentication/authorization"] }), { ui: false, schemaChange: true }).map((r) => r.id);
    expect(high).toEqual(expect.arrayContaining(["security_review", "authorization_tests", "migration_validation", "explicit_approval", "integration_tests"]));
    expect(verificationRequirements(classifyTask(base), { ui: false, schemaChange: false, mandatory: ["security_review"] }).find((r) => r.id === "security_review")!.why).toMatch(/policy/);
  });
  it("a check that could not run leaves the result unverified", () => {
    const st = verificationStatus([{ id: "unit_tests" }, { id: "browser_journeys" }], { unit_tests: "passed", browser_journeys: "unavailable" });
    expect(st.verified).toBe(false);
    expect(st.unverified).toEqual(["browser_journeys"]);
  });
});

describe("tools and models", () => {
  it("selects tools by need and reports unavailable/unpermitted ones instead of pretending", () => {
    const t = toolPlan(classifyTask({ ...base, externalApis: ["resend"], files: ["src/x.js"] }), { permitted: ["repo.search"], available: { browser: false }, ui: true, hasTypecheck: false, hasLint: false });
    expect(t.map((x) => x.tool)).toEqual(expect.arrayContaining(["repo.search", "unit_tests", "browser", "docs.research"]));
    expect(t.find((x) => x.tool === "browser")!.available).toBe(false);
    expect(t.find((x) => x.tool === "docs.research")!.permitted).toBe(false);
    expect(t.map((x) => x.tool)).not.toContain("typecheck");
  });
  const cands = [
    { provider: "anthropic", model: "claude-sonnet", tier: "STANDARD" as const, available: false, supportsTools: true, contextTokens: 200_000 },
    { provider: "anthropic", model: "claude-opus", tier: "REASONING" as const, available: true, supportsTools: true, contextTokens: 200_000 },
    { provider: "other", model: "x-large", tier: "STANDARD" as const, available: true, supportsTools: true, contextTokens: 200_000 },
    { provider: "anthropic", model: "claude-haiku", tier: "FAST" as const, available: true, supportsTools: true, contextTokens: 200_000 },
  ];
  it("falls back only to approved providers at the same or a stronger tier", () => {
    const r = routeModel({ tier: "STANDARD", needsTools: true, contextTokens: 50_000 }, cands, { ...DEFAULT_MODEL_POLICY, allowedProviders: ["anthropic"] });
    expect(r.chosen!.model).toBe("claude-opus");
    expect(r.fallbackUsed).toBe(true);
    expect(r.reasons.join()).toMatch(/not approved/);
  });
  it("honours pins and the no-fallback policy; reports the blocker", () => {
    expect(routeModel({ tier: "STANDARD", needsTools: true, contextTokens: 1 }, cands, { allowedProviders: [], pinnedModels: ["claude-sonnet"], fallback: "fail" }).blocker).toBe("preferred model unavailable");
    expect(routeModel({ tier: "STANDARD", needsTools: true, contextTokens: 1 }, cands, { allowedProviders: ["nobody"], pinnedModels: [], fallback: "fallback" }).blocker).toBe("no compatible provider");
  });
});

describe("feedback controller", () => {
  it("adapts to evidence with a rationale, never randomly", () => {
    expect(adjust({ ...sig, identicalTree: true }).action).toBe("investigate");
    expect(adjust({ ...sig, recurringDefect: true }).action).toBe("add_reproduction");
    expect(adjust({ ...sig, recurringDefect: true, adjustmentsSoFar: ["add_reproduction"] }).action).toBe("escalate_model");
    expect(adjust({ ...sig, scopeGrowth: 5 }).action).toBe("narrow_scope");
    expect(adjust({ ...sig, categories: ["infrastructure"] }).action).toBe("retry_environment");
    expect(adjust({ ...sig, reviewerConflict: true }).action).toBe("add_reviewer");
    expect(adjust(sig).action).toBe("continue");
  });
  it("stops on oscillation, repeated escalation, exhausted adjustments or budget", () => {
    expect(adjust({ ...sig, identicalTree: true, adjustmentsSoFar: ["investigate", "investigate"] }).action).toBe("stop");
    expect(adjust({ ...sig, recurringDefect: true, adjustmentsSoFar: ["add_reproduction", "escalate_model"] }).action).toBe("stop");
    expect(adjust({ ...sig, adjustmentsSoFar: ["investigate", "narrow_scope", "add_reviewer"] }).rationale).toMatch(/3 strategy changes/);
    expect(adjust({ ...sig, budgetLeftUsd: 0 }).source).toBe("budget");
  });
});

describe("collaboration value", () => {
  it("parallel only for independent, disjoint, non-trivial parts", () => {
    expect(collaborationValue([{ key: "a", files: ["src/a.js", "src/a.test.js"], dependsOn: [] }, { key: "b", files: ["public/b.js"], dependsOn: [] }]).worth).toBe(true);
    expect(collaborationValue([{ key: "a", files: ["src/x.js"], dependsOn: [] }, { key: "b", files: ["src/x.js", "y"], dependsOn: [] }]).why).toMatch(/shared files/);
    expect(collaborationValue([{ key: "a", files: ["a", "b"], dependsOn: [] }, { key: "b", files: ["c"], dependsOn: ["a"] }]).worth).toBe(false);
  });
});
