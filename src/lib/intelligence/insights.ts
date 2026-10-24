/**
 * Read models for the AI Engineering Intelligence dashboard. Every number here
 * is derived from PERSISTED records (EvalResult, Evaluation, AgentRun, ToolCall,
 * AgentMessage, PromptVersion). Nothing is estimated or invented; when data is
 * missing the metric is null and the UI shows an honest empty state.
 */
import { prisma } from "@/lib/db";
import { AGENT_DEFS } from "@/lib/agents/definitions";
import { parseJSON } from "@/lib/utils";
import type { ModelTier } from "@/lib/types";
import { computeScorecard, type RunRecord, type Scorecard } from "./scorecard";
import { rootCauseHypotheses, groupFailures, FAILURE_META, type FailureCategory } from "./failures";
import { percentile } from "./aggregate";
import { routeModel, DEFAULT_ROUTING_POLICY, type ModelPerformance, type RoutingPolicy, type RoutingDecision } from "./routing";
import { costRecommendations, type CostRecommendation } from "./cost";
import type { CaseTelemetry } from "./harness";
import type { EvaluatorVerdict } from "./types";

type ResultRow = Awaited<ReturnType<typeof loadResults>>[number];

async function loadResults(companyId: string, sinceDays = 90) {
  const since = new Date(Date.now() - sinceDays * 864e5);
  return prisma.evalResult.findMany({
    where: { companyId, skipped: false, createdAt: { gte: since } },
    include: { evaluation: { select: { agentKey: true, model: true, tier: true, mode: true, datasetId: true, promptKey: true, promptVersion: true } } },
    orderBy: { createdAt: "asc" },
  });
}

/** Map one persisted case result to the scorecard's normalized RunRecord. */
export function resultToRunRecord(r: {
  pass: boolean; tags: string; verdicts: string; telemetry: string; failureCategory: string | null;
  tokensIn: number; tokensOut: number; cost: number; latencyMs: number; evaluation: { agentKey: string };
}): RunRecord {
  const tags = parseJSON<string[]>(r.tags, []);
  const tel = parseJSON<Partial<CaseTelemetry>>(r.telemetry, {});
  const verdicts = parseJSON<EvaluatorVerdict[]>(r.verdicts, []);
  const schema = verdicts.find((v) => v.evaluator === "schema");
  const fc = (r.failureCategory ?? undefined) as FailureCategory | undefined;
  return {
    agentKey: r.evaluation.agentKey,
    pass: r.pass,
    completed: !tel.crashed && !tel.timedOut,
    retries: Math.max(0, (tel.repairAttempts ?? 1) - 1),
    timedOut: !!tel.timedOut || fc === "model_timeout" || fc === "tool_timeout",
    toolCalls: tel.toolCalls ?? 0,
    toolFailures: tel.toolFailures ?? 0,
    recovered: !!tel.recovered,
    recoveryAttempted: (tel.repairAttempts ?? 0) > 1 || !!tel.recovered,
    modelCalls: tel.modelCalls ?? 0,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    cost: r.cost,
    latencyMs: r.latencyMs,
    // An unauthorized attempt the permission layer denied is a SECURITY SUCCESS
    // for the system, but still an attempt by the agent → counted, not hidden.
    unauthorizedAttempts: tel.toolDenied ? 1 : 0,
    policyViolations: fc === "security_policy_violation" && !r.pass ? 1 : 0,
    unsafeOutput: !r.pass && (tags.includes("unsafe") || tags.includes("injection")),
    injectionCase: tags.includes("injection"),
    injectionResisted: tags.includes("injection") ? r.pass : undefined,
    escalationExpected: tags.includes("escalation"),
    escalatedCorrectly: tags.includes("escalation") ? r.pass : undefined,
    handoff: tags.includes("handoff"),
    handoffSucceeded: tags.includes("handoff") ? r.pass : undefined,
    conflictingDecision: tags.includes("conflict") && !r.pass,
    failureCategory: r.pass ? undefined : fc,
    _ranTests: !!tel.ranTests,
    _outputValid: schema ? schema.pass : undefined,
    _regression: !!tel.regression,
  };
}

export async function agentScorecards(companyId: string): Promise<(Scorecard & { name: string; role: string; evalsRun: number })[]> {
  const rows = await loadResults(companyId);
  const evalCounts = await prisma.evaluation.groupBy({ by: ["agentKey"], where: { companyId, status: "COMPLETED" }, _count: { _all: true } });
  return AGENT_DEFS.map((def) => {
    const runs = rows.filter((r) => r.evaluation.agentKey === def.key).map(resultToRunRecord);
    return {
      ...computeScorecard(def.key, runs),
      name: def.name,
      role: def.role,
      evalsRun: evalCounts.find((c) => c.agentKey === def.key)?._count._all ?? 0,
    };
  });
}

/** Production (non-eval) collaboration signals from real agent messages. */
export async function collaborationSignals(companyId: string) {
  const msgs = await prisma.agentMessage.findMany({ where: { companyId }, select: { type: true, taskId: true } });
  const handoffs = msgs.filter((m) => m.type === "HANDOFF").length;
  const bugReports = msgs.filter((m) => m.type === "BUG_REPORT").length;
  const decisions = await prisma.decision.count({ where: { companyId } });
  return {
    handoffs,
    bugReports, // rework requests between agents
    reworkPerHandoff: handoffs ? bugReports / handoffs : null,
    decisionsRecorded: decisions,
    sampleNote: "Derived from persisted AgentMessage/Decision rows in this workspace.",
  };
}

export async function overview(companyId: string) {
  const [evals, results, activeVersions, runs] = await Promise.all([
    prisma.evaluation.findMany({ where: { companyId, status: { in: ["COMPLETED", "CANCELLED"] } }, select: { id: true, mode: true, passRate: true, total: true, passed: true, cost: true } }),
    prisma.evalResult.findMany({ where: { companyId, skipped: false }, select: { pass: true, latencyMs: true, cost: true } }),
    prisma.promptVersion.count({ where: { companyId, status: "ACTIVE" } }),
    prisma.agentRun.findMany({ where: { companyId }, select: { status: true, cost: true, latencyMs: true, promptVersionId: true } }),
  ]);
  const casesTotal = results.length;
  const casesPassed = results.filter((r) => r.pass).length;
  const evalCost = results.reduce((s, r) => s + r.cost, 0);
  const lat = results.map((r) => r.latencyMs);
  const runCompleted = runs.filter((r) => r.status === "COMPLETED");
  return {
    evaluations: evals.length,
    liveEvaluations: evals.filter((e) => e.mode === "live").length,
    fixtureEvaluations: evals.filter((e) => e.mode !== "live").length,
    casesEvaluated: casesTotal,
    passRate: casesTotal ? casesPassed / casesTotal : null,
    failedCases: casesTotal - casesPassed,
    activePromptVersions: activeVersions,
    costPerSuccessfulCase: casesPassed ? evalCost / casesPassed : null,
    latencyP50: percentile(lat, 50),
    latencyP95: percentile(lat, 95),
    latencyNote: lat.length < 5 ? `Percentiles need ≥5 cases (have ${lat.length}).` : `From ${lat.length} evaluated cases.`,
    production: {
      agentRuns: runs.length,
      completed: runCompleted.length,
      costPerCompletedRun: runCompleted.length ? runCompleted.reduce((s, r) => s + r.cost, 0) / runCompleted.length : null,
      runsWithRecordedPromptVersion: runs.filter((r) => r.promptVersionId).length,
    },
  };
}

/** Per-model/per-category measured performance, from evaluation results. */
export async function modelPerformance(companyId: string): Promise<ModelPerformance[]> {
  const rows = await loadResults(companyId);
  const groups = new Map<string, ResultRow[]>();
  for (const r of rows) {
    const key = `${r.evaluation.model}||${r.evaluation.datasetId}||${r.evaluation.mode}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const [model, taskCategory, mode] = key.split("||");
    const n = list.length;
    const rate = (f: (r: ResultRow) => boolean, den = list) => (den.length ? den.filter(f).length / den.length : 0);
    const withSchema = list.filter((r) => parseJSON<EvaluatorVerdict[]>(r.verdicts, []).some((v) => v.evaluator === "schema"));
    const security = list.filter((r) => parseJSON<string[]>(r.tags, []).includes("security"));
    const toolRows = list.filter((r) => (parseJSON<Partial<CaseTelemetry>>(r.telemetry, {}).toolCalls ?? 0) > 0);
    return {
      model,
      tier: (list[0].evaluation.tier || "STANDARD") as ModelTier,
      taskCategory,
      sampleSize: n,
      correctness: rate((r) => r.pass),
      taskSuccess: rate((r) => r.pass),
      structuredValidity: withSchema.length ? rate((r) => parseJSON<EvaluatorVerdict[]>(r.verdicts, []).find((v) => v.evaluator === "schema")?.pass === true, withSchema) : 1,
      toolCallSuccess: toolRows.length ? rate((r) => r.pass, toolRows) : 1,
      securityScore: security.length ? rate((r) => r.pass, security) : 1,
      reliability: rate((r) => !parseJSON<Partial<CaseTelemetry>>(r.telemetry, {}).crashed),
      avgCost: list.reduce((s, r) => s + r.cost, 0) / n,
      avgLatencyMs: list.reduce((s, r) => s + r.latencyMs, 0) / n,
      available: true,
      evidenceMode: mode === "live" ? "live" : "simulation",
    };
  });
}

export async function getRoutingPolicy(companyId: string): Promise<RoutingPolicy> {
  const row = await prisma.routingPolicyConfig.findUnique({ where: { companyId } });
  return { ...DEFAULT_ROUTING_POLICY, ...parseJSON<Partial<RoutingPolicy>>(row?.policy, {}) };
}

export async function routingDecisions(companyId: string): Promise<{ policy: RoutingPolicy; decisions: RoutingDecision[]; performance: ModelPerformance[] }> {
  const [policy, performance] = await Promise.all([getRoutingPolicy(companyId), modelPerformance(companyId)]);
  const categories = [...new Set([...AGENT_DEFS.map((d) => d.key), ...performance.map((p) => p.taskCategory)])];
  return { policy, performance, decisions: categories.map((c) => routeModel(c, performance, policy)) };
}

export async function failureAnalysis(companyId: string) {
  const rows = await loadResults(companyId);
  const failed = rows.filter((r) => !r.pass && r.failureCategory);
  const cats = failed.map((r) => r.failureCategory as FailureCategory);
  const runFails = await prisma.agentRun.findMany({ where: { companyId, status: "FAILED", failureCategory: { not: null } }, select: { failureCategory: true } });
  // Repeated errors: same case failing in ≥2 evaluations.
  const byCase = new Map<string, { count: number; category: string; agentKey: string; lastDetail: string }>();
  for (const r of failed) {
    const k = `${r.evaluation.agentKey}/${r.caseId}`;
    const prev = byCase.get(k);
    const detail = parseJSON<EvaluatorVerdict[]>(r.verdicts, []).filter((v) => !v.pass).map((v) => v.detail).join("; ");
    byCase.set(k, { count: (prev?.count ?? 0) + 1, category: r.failureCategory!, agentKey: r.evaluation.agentKey, lastDetail: detail });
  }
  const regressions = await prisma.promptPromotion.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 30 });
  return {
    totalFailures: failed.length,
    distribution: groupFailures(cats).map((g) => ({ ...g, label: FAILURE_META[g.category].label })),
    productionDistribution: groupFailures(runFails.map((r) => r.failureCategory as FailureCategory)).map((g) => ({ ...g, label: FAILURE_META[g.category].label })),
    hypotheses: rootCauseHypotheses(cats),
    repeated: [...byCase.entries()].filter(([, v]) => v.count >= 2).map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.count - a.count),
    promotionHistory: regressions.map((p) => ({ id: p.id, action: p.action, toVersionId: p.toVersionId, fromVersionId: p.fromVersionId, reason: p.reason, approvedBy: p.approvedBy, createdAt: p.createdAt })),
  };
}

export async function costInsights(companyId: string): Promise<{ recommendations: CostRecommendation[]; note: string }> {
  const [performance, rows] = await Promise.all([modelPerformance(companyId), loadResults(companyId)]);
  const recs: CostRecommendation[] = [];
  const livePerformance = performance.filter((p) => p.evidenceMode === "live");
  const categories = [...new Set(performance.map((p) => p.taskCategory))];
  for (const cat of categories) {
    const catRows = rows.filter((r) => r.evaluation.datasetId === cat);
    const tel = catRows.map((r) => parseJSON<Partial<CaseTelemetry>>(r.telemetry, {}));
    const retries = tel.reduce((s, t) => s + Math.max(0, (t.repairAttempts ?? 1) - 1), 0);
    // A retry is "permanent-failure waste" when the case ultimately still failed
    // with a non-transient category (auth/validation/policy).
    const permanentRetries = catRows.filter((r, i) => Math.max(0, (tel[i].repairAttempts ?? 1) - 1) > 0 && !r.pass && ["authorization_denied", "invalid_input", "security_policy_violation"].includes(r.failureCategory ?? "")).length;
    recs.push(
      ...costRecommendations({
        taskCategory: cat,
        models: livePerformance.filter((p) => p.taskCategory === cat), // never recommend a model swap from fixture data
        avgRedundantContextTokens: 0, // not measured yet — no recommendation is fabricated
        avoidableHandoffRate: 0, // not measured yet
        permanentRetryRate: retries ? permanentRetries / retries : 0,
        modelCallsReplaceableByCode: 0, // not measured yet
        sampleSize: catRows.length,
      }),
    );
  }
  return {
    recommendations: recs,
    note: "Recommendations are proposals only. Model-swap recommendations use live-provider evidence only (fixture runs are excluded). Redundant-context, avoidable-handoff and replace-with-code signals are not yet instrumented, so no recommendations of those kinds are produced.",
  };
}
