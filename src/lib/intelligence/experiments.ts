/**
 * Controlled prompt A/B experiments, gated promotion, and rollback.
 *
 * Experiment: baseline + candidate versions of the SAME template are evaluated
 * on the SAME dataset version, same tier, same seed salts (repetition r uses
 * salt "exp:<id>:r"), so the only variable is the prompt. Repetitions expose
 * variance for nondeterministic (live) models.
 *
 * Promotion (Phase 10): a candidate becomes ACTIVE only if
 *   1. the caller is authorized (enforced by the API layer: ADMIN+),
 *   2. its content hash still verifies (immutability),
 *   3. a FRESH regression evaluation of the candidate passes the release gates
 *      against the current active version's latest evaluation,
 *   4. waivable gates (cost/latency) are only bypassed with an explicit waiver.
 * Otherwise a BLOCKED promotion is recorded with reasons and the previous
 * version stays active. Rollback restores a previously-active version.
 */
import { prisma } from "@/lib/db";
import { audit, emitEvent } from "@/lib/events/emit";
import { runEvaluation, loadEvaluationRun, EvaluationError, EVAL_LIMITS } from "./evaluation";
import { compareRuns, summarizeVariance, type ComparisonResult } from "./compare";
import { evaluateGates, DEFAULT_GATE_CONFIG, type GateConfig, type GateReport } from "./gates";
import { verifyIntegrity } from "./registry";
import { emit as emitLearning } from "@/lib/learning/service";
import { getDataset } from "./datasets";
import type { EvaluationRun } from "./types";

export interface ExperimentInput {
  companyId: string;
  templateKey: string;
  baselineVersionId: string;
  candidateVersionId: string;
  datasetId?: string;
  repetitions?: number;
  gateConfig?: Partial<GateConfig>;
  createdBy: string;
}

/** Merge repeated runs of one arm into a single pooled run (cases concatenated). */
function pool(runs: EvaluationRun[]): EvaluationRun {
  if (runs.length === 1) return runs[0];
  const first = runs[0];
  const cases = runs.flatMap((r, i) => r.cases.map((c) => ({ ...c, caseId: `${c.caseId}#${i + 1}` })));
  const evaluated = cases.filter((c) => !c.skipped);
  const passed = evaluated.filter((c) => c.pass).length;
  const cost = runs.reduce((s, r) => s + r.cost, 0);
  return {
    ...first,
    evaluationId: runs.map((r) => r.evaluationId).join(","),
    cases,
    total: evaluated.length,
    passed,
    failed: evaluated.length - passed,
    skipped: cases.length - evaluated.length,
    passRate: evaluated.length ? passed / evaluated.length : 0,
    avgScore: evaluated.length ? evaluated.reduce((s, c) => s + c.score, 0) / evaluated.length : 0,
    tokensIn: runs.reduce((s, r) => s + r.tokensIn, 0),
    tokensOut: runs.reduce((s, r) => s + r.tokensOut, 0),
    cost,
    costPerPass: passed ? cost / passed : null,
    avgLatencyMs: runs.reduce((s, r) => s + r.avgLatencyMs, 0) / runs.length,
  };
}

export async function runExperiment(input: ExperimentInput) {
  const template = await prisma.promptTemplate.findUnique({
    where: { companyId_key: { companyId: input.companyId, key: input.templateKey } },
  });
  if (!template || !template.agentKey) throw new EvaluationError("Prompt template not found", 404);
  const [baseline, candidate] = await Promise.all([
    prisma.promptVersion.findFirst({ where: { id: input.baselineVersionId, companyId: input.companyId, templateId: template.id } }),
    prisma.promptVersion.findFirst({ where: { id: input.candidateVersionId, companyId: input.companyId, templateId: template.id } }),
  ]);
  if (!baseline || !candidate) throw new EvaluationError("Baseline or candidate version not found in this workspace", 404);
  if (baseline.id === candidate.id) throw new EvaluationError("Baseline and candidate must differ", 422);
  const datasetId = input.datasetId ?? candidate.datasetId ?? template.agentKey;
  const dataset = getDataset(datasetId);
  if (!dataset) throw new EvaluationError(`Unknown dataset ${datasetId}`, 404);
  const repetitions = Math.min(Math.max(1, input.repetitions ?? 1), EVAL_LIMITS.maxRepetitions);
  const gateConfig: GateConfig = { ...DEFAULT_GATE_CONFIG, ...(input.gateConfig ?? {}) };
  // Hard gates may be tightened but never loosened below the defaults.
  gateConfig.minSecurityPassRate = Math.max(gateConfig.minSecurityPassRate, DEFAULT_GATE_CONFIG.minSecurityPassRate);
  gateConfig.minPassRate = Math.max(gateConfig.minPassRate, DEFAULT_GATE_CONFIG.minPassRate);

  const exp = await prisma.promptExperiment.create({
    data: {
      companyId: input.companyId,
      templateId: template.id,
      baselineVersionId: baseline.id,
      candidateVersionId: candidate.id,
      datasetId: dataset.id,
      datasetVersion: dataset.version,
      repetitions,
      gateConfig: JSON.stringify(gateConfig),
      createdBy: input.createdBy,
    },
  });
  if (candidate.status === "DRAFT") await prisma.promptVersion.update({ where: { id: candidate.id }, data: { status: "EVALUATING" } });

  try {
    const baseRuns: EvaluationRun[] = [];
    const candRuns: EvaluationRun[] = [];
    for (let r = 0; r < repetitions; r++) {
      const salt = `exp:${exp.id}:${r}`; // identical salt for both arms
      const common = { companyId: input.companyId, agentKey: template.agentKey, datasetId: dataset.id, experimentId: exp.id, createdBy: input.createdBy, seedSalt: salt };
      baseRuns.push((await runEvaluation({ ...common, promptVersionId: baseline.id, label: "baseline" })).run);
      candRuns.push((await runEvaluation({ ...common, promptVersionId: candidate.id, label: "candidate" })).run);
    }
    const comparison: ComparisonResult = compareRuns(pool(baseRuns), pool(candRuns), gateConfig);
    const variance = { baseline: summarizeVariance(baseRuns), candidate: summarizeVariance(candRuns) };
    const failures = candRuns.flatMap((run) => run.cases.filter((c) => !c.pass && !c.skipped).map((c) => ({ caseId: c.caseId, failureCategory: c.failureCategory, detail: c.verdicts.filter((v) => !v.pass).map((v) => v.detail).join("; ") })));

    // Candidate lifecycle reflects the evidence (never ACTIVE here).
    const nextStatus = comparison.recommendation === "promote" ? "APPROVED" : comparison.recommendation === "block" ? "DRAFT" : "EVALUATING";
    await prisma.promptVersion.update({ where: { id: candidate.id }, data: { status: nextStatus } });

    const done = await prisma.promptExperiment.update({
      where: { id: exp.id },
      data: {
        status: "COMPLETED",
        recommendation: comparison.recommendation,
        summary: comparison.summary,
        comparison: JSON.stringify({ ...comparison, variance, candidateFailures: failures, mode: candRuns[0]?.mode }),
        finishedAt: new Date(),
      },
    });
    await audit(input.companyId, input.createdBy, "PROMPT_EXPERIMENT", exp.id, `${template.key} v${baseline.version} vs v${candidate.version}: ${comparison.recommendation}`);
    return { experiment: done, comparison, variance, candidateFailures: failures };
  } catch (e) {
    await prisma.promptExperiment.update({ where: { id: exp.id }, data: { status: "FAILED", summary: (e as Error).message, finishedAt: new Date() } });
    if (candidate.status === "DRAFT") await prisma.promptVersion.update({ where: { id: candidate.id }, data: { status: "DRAFT" } });
    throw e;
  }
}

export interface PromoteInput {
  companyId: string;
  candidateVersionId: string;
  actor: string;
  /** Explicit, recorded waiver for waivable gates (cost/latency) only. */
  waiveSoftGates?: boolean;
  reason?: string;
}

export interface PromoteResult {
  promoted: boolean;
  gates: GateReport;
  regressionEvaluationId: string;
  activeVersionId: string;
  blockedReasons: string[];
}

export async function promoteVersion(input: PromoteInput): Promise<PromoteResult> {
  const candidate = await prisma.promptVersion.findFirst({ where: { id: input.candidateVersionId, companyId: input.companyId }, include: { template: true } });
  if (!candidate || !candidate.template.agentKey) throw new EvaluationError("Prompt version not found", 404);
  if (candidate.status === "ACTIVE") throw new EvaluationError("Version is already active", 409);
  if (!["APPROVED", "EVALUATING"].includes(candidate.status)) throw new EvaluationError(`Version must be APPROVED (or EVALUATING with a waiver) to promote; it is ${candidate.status}`, 409);
  if (!verifyIntegrity(candidate)) throw new EvaluationError("Integrity check failed: version content does not match its hash", 409);

  const current = await prisma.promptVersion.findFirst({ where: { templateId: candidate.templateId, status: "ACTIVE" } });
  const datasetId = candidate.datasetId ?? candidate.template.agentKey;

  // Baseline evidence: latest completed evaluation of the current active version on this dataset.
  const baselineEval = current
    ? await prisma.evaluation.findFirst({ where: { companyId: input.companyId, promptVersionId: current.id, datasetId, status: "COMPLETED" }, orderBy: { startedAt: "desc" } })
    : null;
  const baselineRun = baselineEval ? await loadEvaluationRun(input.companyId, baselineEval.id) : null;

  // Fresh regression run of the candidate right before activation.
  const regression = await runEvaluation({
    companyId: input.companyId,
    agentKey: candidate.template.agentKey,
    datasetId,
    promptVersionId: candidate.id,
    label: "regression",
    createdBy: input.actor,
    seedSalt: baselineEval ? undefined : `regression:${candidate.id}`,
  });

  const gates = evaluateGates(baselineRun, regression.run);
  const hardFail = gates.checks.some((c) => c.required && !c.pass && !c.waivable);
  const softFail = gates.checks.some((c) => c.required && !c.pass && c.waivable);
  const needsBaseline = !baselineRun && !!current;
  const blockedReasons = [...gates.blockedReasons];
  if (needsBaseline) blockedReasons.push("no completed evaluation of the current active version to compare against — run a baseline first");
  if (softFail && !input.waiveSoftGates) blockedReasons.push("cost/latency tolerance exceeded — requires an explicit waiver");
  if (candidate.status === "EVALUATING" && !input.waiveSoftGates) blockedReasons.push("candidate is not APPROVED by an experiment");
  if (regression.status !== "COMPLETED" || regression.run.total === 0) blockedReasons.push(`regression evaluation did not complete (${regression.stopReason ?? "no evaluated cases"})`);
  // V11: simulated provider output measures the harness, not the model — it can never justify a production prompt change.
  const simulated = regression.run.mode === "simulation" && process.env.AURA_ALLOW_SIMULATED_PROMOTION !== "1";
  if (simulated) blockedReasons.push("evaluation ran on the simulated provider; a prompt can only be promoted on live-model evidence");

  const allowed = !simulated && !hardFail && !needsBaseline && (!softFail || input.waiveSoftGates) && (candidate.status === "APPROVED" || input.waiveSoftGates) && regression.status === "COMPLETED" && regression.run.total > 0;

  if (!allowed) {
    await prisma.promptPromotion.create({
      data: {
        companyId: input.companyId,
        templateId: candidate.templateId,
        fromVersionId: current?.id,
        toVersionId: candidate.id,
        action: "BLOCKED",
        gateReport: JSON.stringify(gates),
        approvedBy: input.actor,
        reason: blockedReasons.join("; "),
      },
    });
    await audit(input.companyId, input.actor, "PROMPT_PROMOTION_BLOCKED", candidate.id, blockedReasons.join("; ").slice(0, 500));
    return { promoted: false, gates, regressionEvaluationId: regression.evaluationId, activeVersionId: current?.id ?? candidate.id, blockedReasons };
  }

  await prisma.$transaction([
    ...(current ? [prisma.promptVersion.update({ where: { id: current.id }, data: { status: "APPROVED" } })] : []),
    prisma.promptVersion.update({ where: { id: candidate.id }, data: { status: "ACTIVE", activatedAt: new Date() } }),
    prisma.promptPromotion.create({
      data: {
        companyId: input.companyId,
        templateId: candidate.templateId,
        fromVersionId: current?.id,
        toVersionId: candidate.id,
        action: "PROMOTE",
        gateReport: JSON.stringify(gates),
        approvedBy: input.actor,
        reason: input.reason ?? (input.waiveSoftGates ? "promoted with explicit soft-gate waiver" : "all gates passed"),
      },
    }),
  ]);
  await emitLearning({ companyId: input.companyId, type: "prompt.promoted", key: `prompt.promoted:${candidate.id}`, payload: { template: candidate.template.key, from: current?.id ?? null, to: candidate.id } });
  await audit(input.companyId, input.actor, "PROMPT_PROMOTED", candidate.id, `${candidate.template.key} v${current?.version ?? "-"} → v${candidate.version}${input.waiveSoftGates ? " (waiver)" : ""}`);
  await emitEvent({ companyId: input.companyId, type: "PROMPT_PROMOTED", actor: candidate.template.agentKey, level: "success", message: `${candidate.template.key} v${candidate.version} is now active` });
  return { promoted: true, gates, regressionEvaluationId: regression.evaluationId, activeVersionId: candidate.id, blockedReasons: [] };
}

export async function rollbackVersion(input: { companyId: string; templateKey: string; targetVersionId: string; actor: string; reason: string }) {
  const template = await prisma.promptTemplate.findUnique({ where: { companyId_key: { companyId: input.companyId, key: input.templateKey } } });
  if (!template) throw new EvaluationError("Prompt template not found", 404);
  const target = await prisma.promptVersion.findFirst({ where: { id: input.targetVersionId, companyId: input.companyId, templateId: template.id } });
  if (!target) throw new EvaluationError("Target version not found", 404);
  if (target.status === "ACTIVE") throw new EvaluationError("Target is already active", 409);
  if (!target.activatedAt) throw new EvaluationError("Can only roll back to a version that was previously active", 409);
  if (!["APPROVED", "ROLLED_BACK"].includes(target.status)) throw new EvaluationError(`Cannot roll back to a ${target.status} version`, 409);
  if (!verifyIntegrity(target)) throw new EvaluationError("Integrity check failed for target version", 409);
  const current = await prisma.promptVersion.findFirst({ where: { templateId: template.id, status: "ACTIVE" } });

  await prisma.$transaction([
    ...(current ? [prisma.promptVersion.update({ where: { id: current.id }, data: { status: "ROLLED_BACK" } })] : []),
    prisma.promptVersion.update({ where: { id: target.id }, data: { status: "ACTIVE", activatedAt: new Date() } }),
    prisma.promptPromotion.create({
      data: {
        companyId: input.companyId,
        templateId: template.id,
        fromVersionId: current?.id,
        toVersionId: target.id,
        action: "ROLLBACK",
        approvedBy: input.actor,
        reason: input.reason,
      },
    }),
  ]);
  await emitLearning({ companyId: input.companyId, type: "prompt.rolled_back", key: `prompt.rolled_back:${target.id}:${Date.now()}`, payload: { template: template.key, from: current?.id ?? null, to: target.id, reason: input.reason } });
  await audit(input.companyId, input.actor, "PROMPT_ROLLBACK", target.id, `${template.key} v${current?.version ?? "-"} → v${target.version}: ${input.reason}`.slice(0, 500));
  await emitEvent({ companyId: input.companyId, type: "PROMPT_PROMOTED", actor: template.agentKey ?? undefined, level: "warning", message: `${template.key} rolled back to v${target.version}` });
  return { activeVersionId: target.id, rolledBackVersionId: current?.id ?? null };
}
