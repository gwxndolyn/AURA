/**
 * Learning service (AURA V11): turns recorded engineering outcomes into
 * durable, evidence-linked knowledge — without ever blocking delivery.
 *
 *   emit(event)        append to LearningEvent with a stable key (retries and
 *                      duplicate emits are no-ops). Never throws into callers.
 *   processPending()   background step (worker maintenance + job): processes
 *                      unprocessed events; each handler is idempotent (upserts
 *                      keyed by build/attempt), so crashes mid-way are safe.
 *
 * Handlers:
 *   attempt.completed  → FailureAttribution rows for a failed attempt (from the
 *                        attempt's recorded defects/findings); when a later
 *                        attempt passes, the previous attributions' corrective
 *                        actions are VERIFIED (or FAILED when the run fails)
 *   build.finished     → RunOutcome (one per run), recipe application outcomes,
 *                        recipe revalidation, negative memory (failed approaches)
 *   rework.requested   → marks the run's outcome + an intent_mismatch attribution
 *
 * All rows are workspace-scoped; nothing is promoted across workspaces.
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { log } from "@/lib/observability/log";
import { attribute, ATTRIBUTION_RULES_VERSION, type AttributionInput } from "./attribution";
import { revalidate } from "./recipes";
import { remember } from "@/lib/factory/memory";

export type LearningEventType = "build.started" | "attempt.completed" | "build.finished" | "plan.approved" | "delivered" | "rework.requested" | "feedback.recorded" | "benchmark.completed" | "prompt.promoted" | "prompt.rolled_back";

export async function emit(e: { companyId: string; type: LearningEventType; key: string; productId?: string | null; buildId?: string | null; itemKey?: string | null; payload?: Record<string, unknown> }) {
  try {
    await prisma.learningEvent.create({ data: { companyId: e.companyId, type: e.type, key: e.key, productId: e.productId ?? null, buildId: e.buildId ?? null, itemKey: e.itemKey ?? null, payload: JSON.stringify(e.payload ?? {}) } });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return false; // already recorded
    log("warn", "learning.emit_failed", { type: e.type, key: e.key, error: (err as Error).message }); // learning must never break delivery
    return false;
  }
}

export interface AttemptPayload {
  attempt: number;
  passed: boolean;
  changed: string[];
  plannedFiles: string[];
  findings: AttributionInput["findings"];
  unmet: AttributionInput["unmet"];
  impactFlags: AttributionInput["impactFlags"];
  knownFiles: string[];
  error?: { kind: string; message: string } | null;
  ownerAgent: string;
  promptRef?: string | null;
}

async function onAttempt(companyId: string, buildId: string, p: AttemptPayload) {
  const b = await prisma.build.findFirst({ where: { id: buildId, companyId } });
  if (!b) return;
  const prior = await prisma.failureAttribution.findMany({ where: { buildId, attempt: { lt: p.attempt } } });
  if (p.passed) {
    // The corrective actions taken after earlier failures are proven by this passing attempt.
    await prisma.failureAttribution.updateMany({ where: { buildId, verification: "PENDING", attempt: { lt: p.attempt } }, data: { verification: "VERIFIED", resolvedAt: new Date() } });
    return;
  }
  const defects = await prisma.defect.findMany({ where: { buildId, companyId, lastAttempt: p.attempt } });
  const input: AttributionInput = {
    attempt: p.attempt, ownerAgent: p.ownerAgent, promptRef: p.promptRef,
    defects: defects.map((d) => ({ signature: d.signature, category: d.category, title: d.title, occurrences: d.occurrences, files: parseJSON<string[]>(d.files, []), failingTests: parseJSON<string[]>(d.failingTests, []), commandRunId: d.commandRunId, diagnosis: d.diagnosis })),
    findings: p.findings, unmet: p.unmet, changed: p.changed, plannedFiles: p.plannedFiles, impactFlags: p.impactFlags, knownFiles: p.knownFiles, error: p.error ?? null,
    previous: [...new Set(prior.map((a) => a.attempt))].map((a) => ({ attempt: a, categories: prior.filter((x) => x.attempt === a).map((x) => x.category) })),
  };
  // Earlier attributions whose category recurs were NOT fixed by their corrective action.
  const now = attribute(input);
  for (const pa of prior.filter((x) => x.verification === "PENDING" && now.some((n) => n.category === x.category))) await prisma.failureAttribution.update({ where: { id: pa.id }, data: { verification: "FAILED" } });
  for (const a of now) {
    await prisma.failureAttribution.upsert({
      where: { buildId_attempt_category: { buildId, attempt: p.attempt, category: a.category } },
      create: { companyId, productId: b.productId, buildId, itemKey: b.itemKey, attempt: p.attempt, category: a.category, scope: a.scope, agentKey: a.agentKey, promptRef: a.scope === "agent" ? p.promptRef ?? null : null, rootCause: a.rootCause, symptoms: JSON.stringify(a.symptoms), evidence: JSON.stringify(a.evidence), confidence: a.confidence, status: a.status, correctiveAction: a.correctiveAction, verification: a.scope === "environment" || a.scope === "external" ? "NOT_APPLICABLE" : "PENDING", rulesVersion: ATTRIBUTION_RULES_VERSION },
      update: {},
    });
  }
}

const TERMINAL: Record<string, { outcome: string; cls: string }> = {
  VERIFIED: { outcome: "VERIFIED", cls: "agent" },
  FAILED: { outcome: "FAILED", cls: "agent" },
  CANCELLED: { outcome: "CANCELLED", cls: "user" },
};

/** Build → RunOutcome (pure function of the run's stored records; recomputed idempotently). */
export async function collectOutcome(companyId: string, buildId: string) {
  const b = await prisma.build.findFirst({ where: { id: buildId, companyId }, include: { commands: { where: { actor: "engine" }, select: { id: true, purpose: true, command: true, exitCode: true, timedOut: true } } } });
  if (!b || ["QUEUED", "RUNNING"].includes(b.status) || b.itemKey === "RELEASE") return null;
  const [item, product, runs, defects, attributions, apps] = await Promise.all([
    prisma.backlogItem.findFirst({ where: { productId: b.productId, companyId, key: b.itemKey } }),
    prisma.product.findFirst({ where: { id: b.productId, companyId }, select: { stack: true } }),
    prisma.agentRun.findMany({ where: { companyId, objective: { startsWith: `[build ${b.id}]` } }, select: { promptRef: true, model: true, agent: { select: { key: true } } } }),
    prisma.defect.findMany({ where: { buildId: b.id, companyId } }),
    prisma.failureAttribution.findMany({ where: { buildId: b.id } }),
    prisma.recipeApplication.findMany({ where: { buildId: b.id, companyId }, include: { recipe: { select: { key: true } } } }),
  ]);
  const orch = parseJSON<{ risk?: string; attempts?: { passed: boolean; blocking?: number; unmet?: number }[] }>(b.orchestration, {});
  const criteria = parseJSON<{ status: string }[]>(b.criteria, []);
  const findings = parseJSON<{ source: string; blocking: boolean }[]>(b.findings, []);
  // Infrastructure / budget stops are tracked separately, never as agent failures (or successes).
  let { outcome, cls } = TERMINAL[b.status] ?? { outcome: "BLOCKED", cls: "agent" };
  if (b.status === "BLOCKED") {
    const envOnly = attributions.length > 0 && attributions.every((a) => a.scope === "environment" || a.scope === "external");
    if (b.stopReason === "budget") { outcome = "BUDGET_STOPPED"; cls = "budget"; }
    else if (envOnly || /sandbox|provider|unavailable|Docker|infrastructure or configuration/i.test(b.failure)) { outcome = "INFRA_FAILED"; cls = /provider/i.test(b.failure) ? "external" : "environment"; }
  }
  const tests = b.commands.map((c) => ({ command: c.command, purpose: c.purpose, exitCode: c.exitCode, timedOut: c.timedOut, ran: c.exitCode !== null || c.timedOut }));
  const testRuns = tests.filter((t) => t.purpose === "test");
  const first = orch.attempts?.[0];
  const firstPass = !!first && first.passed && !(first.blocking ?? 0) && !(first.unmet ?? 0) && b.status === "VERIFIED";
  const owner = parseJSON<string[]>(item?.capabilities ?? "[]", [])[0] ?? "backend-engineer";
  const data = {
    companyId, productId: b.productId, itemKey: b.itemKey, taskKind: item?.kind ?? "", stack: product?.stack ?? "", ownerAgent: owner,
    promptRefs: JSON.stringify([...new Set(runs.map((r) => `${r.agent.key}:${r.promptRef}`))]),
    models: JSON.stringify([...new Set(runs.map((r) => r.model).filter(Boolean))]),
    risk: orch.risk ?? item?.risk ?? "",
    requirement: JSON.stringify({ title: item?.title ?? "", acceptance: parseJSON<string[]>(item?.acceptance ?? "[]", []), requirements: parseJSON<string[]>(item?.requirements ?? "[]", []) }),
    files: JSON.stringify(parseJSON<string[]>(b.changed, []).map((c) => c.replace(/^\S+\s+/, ""))),
    tests: JSON.stringify(tests.slice(-30)),
    testsRun: testRuns.filter((t) => t.ran).length, // a test that did not run is never counted
    testsPassed: testRuns.filter((t) => t.exitCode === 0 && !t.timedOut).length,
    criteriaTotal: criteria.length, criteriaMet: criteria.filter((c) => c.status === "met").length,
    reviewFindings: findings.filter((f) => ["qa", "review"].includes(f.source)).length,
    securityFindings: findings.filter((f) => f.source === "security").length,
    browserStatus: parseJSON<{ status?: string }>(b.browser, {}).status ?? "not_applicable",
    defects: JSON.stringify(defects.map((d) => ({ signature: d.signature, category: d.category, status: d.status, occurrences: d.occurrences }))),
    attempts: b.attempt + 1, firstPassSuccess: firstPass, outcome, outcomeClass: cls,
    regression: parseJSON<{ flags?: { confidence: string }[] }>(b.impact, {}).flags?.some((f) => f.confidence === "confirmed") ?? false,
    recipeKeys: JSON.stringify(apps.map((a) => a.recipe.key)),
    costUsd: b.costUsd, tokens: b.tokensIn + b.tokensOut,
    durationMs: b.startedAt && b.finishedAt ? b.finishedAt.getTime() - b.startedAt.getTime() : 0,
    finishedAt: b.finishedAt,
  };
  const row = await prisma.runOutcome.upsert({ where: { buildId: b.id }, create: { buildId: b.id, ...data }, update: data });
  // Recipe outcomes: infra/budget/cancel are EXCLUDED, not successes or failures.
  const appOutcome = outcome === "VERIFIED" ? "VERIFIED" : outcome === "FAILED" || outcome === "BLOCKED" ? "FAILED" : "EXCLUDED";
  for (const a of apps) {
    await prisma.recipeApplication.update({ where: { id: a.id }, data: { outcome: appOutcome, attempts: b.attempt + 1 } });
    await revalidate(a.recipeId);
  }
  // Unresolved attributions of a failed run: their corrective actions did not work.
  if (outcome === "FAILED") await prisma.failureAttribution.updateMany({ where: { buildId: b.id, verification: "PENDING" }, data: { verification: "FAILED" } });
  // Negative knowledge: approaches that failed in this project, so the next attempt does not repeat them blindly.
  if (outcome === "FAILED") {
    const est = attributions.filter((a) => a.status === "ESTABLISHED" && a.scope === "agent").slice(0, 3);
    for (const a of est) await remember({ companyId, productId: b.productId, key: `failed:${b.itemKey}:${a.category}`, kind: "limitation", content: `A previous run of ${b.itemKey} failed: ${a.rootCause}. The corrective action "${a.correctiveAction}" did not resolve it within ${b.attempt + 1} attempt(s) — do not repeat that approach unchanged.`, status: "VERIFIED", files: data.files ? JSON.parse(data.files) : [], sourceSha: b.headSha, provenance: { type: "build", ref: b.id, detail: `failed run, attribution ${a.id}` } });
  }
  return row;
}

async function onRework(companyId: string, buildId: string, text: string) {
  const b = await prisma.build.findFirst({ where: { id: buildId, companyId } });
  if (!b) return;
  await prisma.runOutcome.updateMany({ where: { buildId, companyId }, data: { reworkRequested: true } });
  const attempt = 1000; // user-level attribution, after the engine's attempts
  await prisma.failureAttribution.upsert({ where: { buildId_attempt_category: { buildId, attempt, category: "intent_mismatch" } }, create: { companyId, productId: b.productId, buildId, itemKey: b.itemKey, attempt, category: "intent_mismatch", scope: "workflow", rootCause: "The user reported that the delivered result does not match their intent", symptoms: JSON.stringify([text.slice(0, 300)]), evidence: JSON.stringify([{ kind: "user_feedback", ref: buildId, detail: text.slice(0, 300) }]), confidence: "high", status: "ESTABLISHED", correctiveAction: "clarify the requirement and re-plan the affected task", verification: "PENDING", rulesVersion: ATTRIBUTION_RULES_VERSION }, update: {} });
}

/** Process up to `limit` pending events (oldest first). Safe to run concurrently with itself (claim by attempts CAS). */
export async function processPending(limit = 50, companyIds?: string[]) {
  const rows = await prisma.learningEvent.findMany({ where: { processedAt: null, attempts: { lt: 5 }, ...(companyIds ? { companyId: { in: companyIds } } : {}) }, orderBy: { createdAt: "asc" }, take: limit });
  let done = 0;
  for (const e of rows) {
    const claim = await prisma.learningEvent.updateMany({ where: { id: e.id, processedAt: null, attempts: e.attempts }, data: { attempts: { increment: 1 } } });
    if (!claim.count) continue;
    try {
      const p = parseJSON<Record<string, unknown>>(e.payload, {});
      if (e.type === "attempt.completed" && e.buildId) await onAttempt(e.companyId, e.buildId, p as unknown as AttemptPayload);
      else if (e.type === "build.finished" && e.buildId) await collectOutcome(e.companyId, e.buildId);
      else if (e.type === "rework.requested" && e.buildId) await onRework(e.companyId, e.buildId, String(p.text ?? ""));
      await prisma.learningEvent.update({ where: { id: e.id }, data: { processedAt: new Date(), error: "" } });
      done++;
    } catch (err) {
      await prisma.learningEvent.update({ where: { id: e.id }, data: { error: (err as Error).message.slice(0, 500) } }).catch(() => null);
      log("warn", "learning.event_failed", { id: e.id, type: e.type, error: (err as Error).message });
    }
  }
  return done;
}

export type PerfMetric = { value: number | null; numerator: number; denominator: number; formula: string; unavailable?: string };
const pm = (n: number, d: number, formula: string, why: string): PerfMetric => ({ value: d ? n / d : null, numerator: n, denominator: d, formula, ...(d ? {} : { unavailable: why }) });

/**
 * Agent performance history from RunOutcomes (workspace-scoped). Denominators
 * are explicit: infra/budget/cancelled runs are reported separately and
 * excluded from quality rates; nothing is silently dropped.
 */
export async function agentPerformance(companyId: string, opts: { since?: Date } = {}) {
  const rows = await prisma.runOutcome.findMany({ where: { companyId, ...(opts.since ? { createdAt: { gte: opts.since } } : {}) } });
  const attributions = await prisma.failureAttribution.findMany({ where: { companyId, ...(opts.since ? { createdAt: { gte: opts.since } } : {}) }, select: { agentKey: true, scope: true, category: true, promptRef: true, buildId: true } });
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    // The owner's prompt version for this run ("agent:promptRef"); several turns share one ref.
    const ref = parseJSON<string[]>(r.promptRefs, []).find((x) => x.startsWith(`${r.ownerAgent}:`))?.slice(r.ownerAgent.length + 1) ?? "unknown";
    const key = `${r.ownerAgent}|${r.taskKind}|${ref}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].map(([key, rs]) => {
    const [agent, kind, promptRef] = key.split("|");
    const quality = rs.filter((r) => ["VERIFIED", "FAILED", "BLOCKED"].includes(r.outcome));
    const excluded = rs.length - quality.length;
    const verified = quality.filter((r) => r.outcome === "VERIFIED");
    const agentBlame = attributions.filter((a) => a.scope === "agent" && a.agentKey === agent && rs.some((r) => r.buildId === a.buildId)).length;
    return {
      agent, taskKind: kind, promptRef, runs: rs.length, excluded: { count: excluded, reasons: [...new Set(rs.filter((r) => !quality.includes(r)).map((r) => r.outcome))] },
      metrics: {
        verifiedRate: pm(verified.length, quality.length, "runs VERIFIED / runs that reached a quality verdict (infra, budget and cancelled runs excluded and listed)", "no run reached a verdict"),
        firstPassSuccess: pm(quality.filter((r) => r.firstPassSuccess).length, quality.length, "runs verified on the first attempt with no blocking findings / runs with a verdict", "no run reached a verdict"),
        criteriaMet: pm(quality.reduce((s, r) => s + r.criteriaMet, 0), quality.reduce((s, r) => s + r.criteriaTotal, 0), "acceptance criteria met / criteria assessed", "no criteria assessed"),
        // Excessive retries are not rewarded: mean attempts per verified run is reported, and repairs count against first-pass.
        attemptsPerVerified: pm(verified.reduce((s, r) => s + r.attempts, 0), verified.length, "mean attempts per verified run", "no verified run"),
        regressionRate: pm(quality.filter((r) => r.regression).length, quality.length, "runs with a confirmed regression / runs with a verdict", "no run reached a verdict"),
        reworkRate: pm(verified.filter((r) => r.reworkRequested).length, verified.length, "verified runs the user sent back for rework / verified runs", "no verified run"),
        agentAttributedFailures: { value: agentBlame, numerator: agentBlame, denominator: quality.length, formula: "failure attributions with agent scope for this agent (infra/provider never counted)" } as PerfMetric,
      },
      costUsd: rs.reduce((s, r) => s + r.costUsd, 0),
    };
  }).sort((a, b) => b.runs - a.runs);
}
