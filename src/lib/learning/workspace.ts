/**
 * Read model for the engineering-intelligence workspace. Every value comes
 * from persisted records; a metric with no data is `unavailable` with the
 * reason. Evidence links are ids the UI resolves through tenant-checked routes.
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { agentPerformance } from "./service";
import { problems } from "./optimize";
import { recipeStats } from "./recipes";
import { PROMPT_LIBRARY_VERSION } from "@/lib/agents/prompts";

export async function intelligenceOverview(companyId: string, opts: { productId?: string; q?: string } = {}) {
  const pf = opts.productId ? { productId: opts.productId } : {};
  const [outcomes, attrs, memory, feedback, apps, promotions, experiments, labExperiments, pending] = await Promise.all([
    prisma.runOutcome.findMany({ where: { companyId, ...pf }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.failureAttribution.findMany({ where: { companyId, ...pf }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.projectMemory.findMany({ where: { companyId, ...pf, ...(opts.q ? { OR: [{ content: { contains: opts.q } }, { key: { contains: opts.q } }] } : {}) }, orderBy: { updatedAt: "desc" }, take: 150 }),
    prisma.userFeedback.findMany({ where: { companyId, ...(opts.productId ? { OR: [{ productId: opts.productId }, { scope: "workspace" }] } : {}) }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.recipeApplication.findMany({ where: { companyId, ...pf }, include: { recipe: true }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.promptPromotion.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.promptExperiment.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, templateId: true, status: true, recommendation: true, summary: true, createdAt: true, comparison: true } }),
    prisma.labExperiment.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, key: true, title: true, status: true, decision: true, createdAt: true } }),
    prisma.learningEvent.count({ where: { companyId, processedAt: null } }),
  ]);
  const products = await prisma.product.findMany({ where: { companyId, id: { in: [...new Set([...outcomes.map((o) => o.productId), ...attrs.map((a) => a.productId), ...memory.map((m) => m.productId)])] } }, select: { id: true, title: true } });
  const title = (id: string) => products.find((p) => p.id === id)?.title ?? id.slice(-6);
  const verdicts = outcomes.filter((o) => ["VERIFIED", "FAILED", "BLOCKED"].includes(o.outcome));
  const rate = (n: number, d: number, f: string, why: string) => ({ value: d ? n / d : null, numerator: n, denominator: d, formula: f, ...(d ? {} : { unavailable: why }) });

  // Actionable insights first.
  const insights: { severity: "high" | "medium" | "low"; title: string; detail: string; evidence: { kind: string; id: string }[] }[] = [];
  for (const p of (await problems(companyId)).slice(0, 3)) insights.push({ severity: p.failures >= 3 ? "high" : "medium", title: `${p.agentKey}: recurring ${p.category.replace(/_/g, " ")}`, detail: `${p.failures} run(s) failed with this established cause. A bounded prompt change can be evaluated from here.`, evidence: p.evidence.map((e) => ({ kind: "build", id: e.buildId })) });
  const unresolved = attrs.filter((a) => a.status !== "UNKNOWN" && a.verification === "FAILED").slice(0, 3);
  for (const a of unresolved) insights.push({ severity: "medium", title: `Fix did not work: ${a.itemKey}`, detail: `${a.rootCause} — tried "${a.correctiveAction}"`, evidence: [{ kind: "build", id: a.buildId }] });
  const infra = outcomes.filter((o) => o.outcome === "INFRA_FAILED").length;
  if (infra) insights.push({ severity: "low", title: `${infra} run(s) stopped by the environment`, detail: "Sandbox or provider failures. They are excluded from agent quality metrics.", evidence: outcomes.filter((o) => o.outcome === "INFRA_FAILED").slice(0, 5).map((o) => ({ kind: "build", id: o.buildId })) });

  const recipeMap = new Map<string, { recipe: (typeof apps)[number]["recipe"]; apps: typeof apps }>();
  for (const a of apps) recipeMap.set(a.recipeId, { recipe: a.recipe, apps: [...(recipeMap.get(a.recipeId)?.apps ?? []), a] });
  const recipes = await Promise.all([...recipeMap.values()].map(async ({ recipe, apps: rs }) => ({ id: recipe.id, key: recipe.key, title: recipe.title, version: recipe.version, status: recipe.status, scope: recipe.scope === "platform" ? "platform" : "workspace", inThisWorkspace: { verified: rs.filter((x) => x.outcome === "VERIFIED").length, failed: rs.filter((x) => x.outcome === "FAILED").length, excluded: rs.filter((x) => x.outcome === "EXCLUDED").length, pending: rs.filter((x) => x.outcome === "PENDING").length }, overall: recipe.scope === "platform" ? await recipeStats(recipe.id) : null })));

  return {
    promptLibrary: PROMPT_LIBRARY_VERSION,
    pendingEvents: pending,
    insights,
    summary: {
      runs: outcomes.length,
      byOutcome: Object.fromEntries([...new Set(outcomes.map((o) => o.outcome))].map((k) => [k, outcomes.filter((o) => o.outcome === k).length])),
      verifiedRate: rate(verdicts.filter((o) => o.outcome === "VERIFIED").length, verdicts.length, "verified / runs with a quality verdict (infrastructure, budget and cancelled runs listed separately)", "no run has reached a verdict"),
      firstPassSuccess: rate(verdicts.filter((o) => o.firstPassSuccess).length, verdicts.length, "verified on the first attempt / runs with a verdict", "no run has reached a verdict"),
      testsExecuted: { passed: outcomes.reduce((s, o) => s + o.testsPassed, 0), run: outcomes.reduce((s, o) => s + o.testsRun, 0), note: "only executed test commands are counted" },
      reworkRate: rate(outcomes.filter((o) => o.outcome === "VERIFIED" && o.reworkRequested).length, outcomes.filter((o) => o.outcome === "VERIFIED").length, "verified runs sent back by a user / verified runs", "no verified run"),
    },
    failures: attrs.map((a) => ({ id: a.id, product: title(a.productId), productId: a.productId, buildId: a.buildId, itemKey: a.itemKey, attempt: a.attempt + 1, category: a.category, scope: a.scope, agentKey: a.agentKey, rootCause: a.rootCause, symptoms: parseJSON<string[]>(a.symptoms, []), evidence: parseJSON<{ kind: string; ref: string; detail: string }[]>(a.evidence, []), confidence: a.confidence, status: a.status, correctiveAction: a.correctiveAction, verification: a.verification, createdAt: a.createdAt })),
    memory: memory.map((m) => ({ id: m.id, product: title(m.productId), productId: m.productId, key: m.key, kind: m.kind, content: m.content, status: m.status, staleReason: m.staleReason, provenance: parseJSON(m.provenance, {}), uses: m.uses, updatedAt: m.updatedAt })),
    decisions: memory.filter((m) => ["decision", "approved_decision", "api_contract"].includes(m.kind) && m.status !== "INVALIDATED").slice(0, 20).map((m) => ({ id: m.id, key: m.key, content: m.content, status: m.status })),
    knownIssues: memory.filter((m) => m.key.startsWith("failed:") || m.kind === "limitation").slice(0, 20).map((m) => ({ id: m.id, key: m.key, content: m.content, status: m.status })),
    recipes,
    agents: await agentPerformance(companyId),
    runs: outcomes.slice(0, 30).map((o) => ({ buildId: o.buildId, product: title(o.productId), productId: o.productId, itemKey: o.itemKey, kind: o.taskKind, agent: o.ownerAgent, outcome: o.outcome, attempts: o.attempts, firstPass: o.firstPassSuccess, tests: `${o.testsPassed}/${o.testsRun}`, criteria: `${o.criteriaMet}/${o.criteriaTotal}`, browser: o.browserStatus, rework: o.reworkRequested, recipes: parseJSON<string[]>(o.recipeKeys, []), promptRefs: parseJSON<string[]>(o.promptRefs, []), finishedAt: o.finishedAt })),
    feedback: feedback.map((f) => ({ id: f.id, text: f.text, kind: f.kind, scope: f.scope, status: f.status, product: f.productId ? title(f.productId) : null, actions: parseJSON<{ type: string; detail: string }[]>(f.actions, []), appliedCount: f.appliedCount, lastAppliedAt: f.lastAppliedAt, createdAt: f.createdAt })),
    optimization: {
      promotions: promotions.map((p) => ({ id: p.id, action: p.action, reason: p.reason, approvedBy: p.approvedBy, createdAt: p.createdAt })),
      promptExperiments: experiments.map((e) => ({ id: e.id, status: e.status, recommendation: e.recommendation, summary: e.summary, mode: parseJSON<{ mode?: string }>(e.comparison, {}).mode ?? null, createdAt: e.createdAt })),
      methodExperiments: labExperiments.map((e) => ({ id: e.id, key: e.key, title: e.title, status: e.status, reasons: parseJSON<{ reasons?: string[] }>(e.decision, {}).reasons?.slice(0, 4) ?? [], createdAt: e.createdAt })),
    },
  };
}
