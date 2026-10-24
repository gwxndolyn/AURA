/**
 * Centralized evaluation engine. Runs a versioned dataset against a registered
 * agent + a specific prompt version, persists an Evaluation + per-case
 * EvalResults, and returns the aggregated EvaluationRun.
 *
 * Governance (Phase 13):
 *  - workspace-scoped: prompt version must belong to `companyId`.
 *  - bounded: max model calls + max USD per evaluation, cancellable via
 *    AbortSignal, wall-clock timeout; respects the workspace daily budget.
 *  - redacted: outputs are redacted + truncated before persistence.
 *  - audited + emits EVALUATION_COMPLETED.
 *  - concurrency: at most MAX_CONCURRENT evaluations per workspace.
 */
import { prisma } from "@/lib/db";
import { MODELS, aiMode } from "@/lib/ai/claude";
import { checkBudget } from "@/lib/agents/guardrails";
import { getAgentDef } from "@/lib/agents/definitions";
import { audit, emitEvent } from "@/lib/events/emit";
import type { ModelTier } from "@/lib/types";
import { getDataset } from "./datasets";
import { runCase, EvaluationBudgetError, type CaseTelemetry, type HarnessContext } from "./harness";
import { aggregateRun } from "./aggregate";
import type { CaseResult, EvaluationRun } from "./types";
import { redactDeep } from "./redact";
import { agentPromptKey, ensureBuiltinPrompts } from "./registry";

/** Version of the tool schema/permission catalogue the harness exercises. */
export const TOOL_SCHEMA_VERSION = "permissions@1";

export const EVAL_LIMITS = {
  maxModelCalls: Number(process.env.AURA_EVAL_MAX_MODEL_CALLS ?? 40),
  maxCostUsd: Number(process.env.AURA_EVAL_MAX_COST_USD ?? 1),
  timeoutMs: Number(process.env.AURA_EVAL_TIMEOUT_MS ?? 120000),
  maxConcurrent: 2,
  maxRepetitions: 5,
};

const running = new Map<string, number>(); // companyId -> count (single-process)
const controllers = new Map<string, AbortController>(); // evaluationId -> controller

export class EvaluationError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "EvaluationError";
  }
}

export interface RunEvaluationInput {
  companyId: string;
  agentKey: string;
  datasetId: string;
  /** Prompt version id to evaluate; default = the template's ACTIVE version. */
  promptVersionId?: string;
  tier?: ModelTier;
  label?: "baseline" | "candidate" | "regression" | "adhoc";
  experimentId?: string;
  createdBy: string;
  /** Salt for the simulator seed. Same salt ⇒ identical fixture outputs. */
  seedSalt?: string;
}

export interface EvaluationOutcome {
  evaluationId: string;
  run: EvaluationRun;
  telemetry: Record<string, CaseTelemetry>;
  status: "COMPLETED" | "CANCELLED" | "FAILED";
  stopReason?: string;
}

export async function runEvaluation(input: RunEvaluationInput): Promise<EvaluationOutcome> {
  const def = getAgentDef(input.agentKey);
  if (!def) throw new EvaluationError(`Unknown agent: ${input.agentKey}`, 404);
  const dataset = getDataset(input.datasetId);
  if (!dataset) throw new EvaluationError(`Unknown dataset: ${input.datasetId}`, 404);
  if (dataset.agentKey !== input.agentKey)
    throw new EvaluationError(`Dataset ${dataset.id} targets ${dataset.agentKey}, not ${input.agentKey}`, 422);

  await ensureBuiltinPrompts(input.companyId);
  const template = await prisma.promptTemplate.findUnique({
    where: { companyId_key: { companyId: input.companyId, key: agentPromptKey(input.agentKey) } },
  });
  if (!template) throw new EvaluationError("Prompt template missing", 500);
  // Workspace-scoped lookup — a version id from another workspace is "not found".
  const version = input.promptVersionId
    ? await prisma.promptVersion.findFirst({ where: { id: input.promptVersionId, companyId: input.companyId, templateId: template.id } })
    : await prisma.promptVersion.findFirst({ where: { templateId: template.id, status: "ACTIVE" } });
  if (!version) throw new EvaluationError("Prompt version not found", 404);

  // Respect the workspace daily AI budget before spending anything.
  const budget = await checkBudget(input.companyId);
  if (!budget.ok) throw new EvaluationError(`Evaluation blocked: ${budget.reason}`, 429);

  const active = running.get(input.companyId) ?? 0;
  if (active >= EVAL_LIMITS.maxConcurrent) throw new EvaluationError("Too many evaluations running for this workspace", 429);
  running.set(input.companyId, active + 1);

  const tier = input.tier ?? def.tier;
  const mode = aiMode();
  const evaluation = await prisma.evaluation.create({
    data: {
      companyId: input.companyId,
      agentKey: input.agentKey,
      workflow: "agent.turn",
      provider: "anthropic",
      model: mode === "live" ? MODELS[tier] : `${MODELS[tier]} (sim)`,
      tier,
      mode,
      promptVersionId: version.id,
      promptKey: template.key,
      promptVersion: version.version,
      toolSchemaVersion: TOOL_SCHEMA_VERSION,
      datasetId: dataset.id,
      datasetVersion: dataset.version,
      experimentId: input.experimentId,
      label: input.label ?? "adhoc",
      status: "RUNNING",
      createdBy: input.createdBy,
    },
  });

  const controller = new AbortController();
  controllers.set(evaluation.id, controller);
  const timer = setTimeout(() => controller.abort(), EVAL_LIMITS.timeoutMs);

  const ctx: HarnessContext = {
    agentKey: input.agentKey,
    systemPrompt: version.content,
    tier,
    seedSalt: input.seedSalt ?? `${dataset.id}@${dataset.version}`,
    budget: { maxModelCalls: EVAL_LIMITS.maxModelCalls, modelCalls: 0, maxCostUsd: EVAL_LIMITS.maxCostUsd, costUsd: 0 },
    signal: controller.signal,
  };

  // Previous completed evaluation of the same prompt+dataset, for regression flags.
  const previous = await prisma.evaluation.findFirst({
    where: { companyId: input.companyId, promptVersionId: version.id, datasetId: dataset.id, status: "COMPLETED", id: { not: evaluation.id } },
    orderBy: { startedAt: "desc" },
    include: { results: { select: { caseId: true, pass: true, skipped: true } } },
  });
  const prevPass = new Map(previous?.results.filter((r) => !r.skipped).map((r) => [r.caseId, r.pass]) ?? []);

  const results: (CaseResult & { telemetry: CaseTelemetry })[] = [];
  let status: EvaluationOutcome["status"] = "COMPLETED";
  let stopReason: string | undefined;
  try {
    for (const c of dataset.cases) {
      try {
        const r = await runCase(ctx, c);
        if (!r.skipped && prevPass.get(c.id) === true && !r.pass) r.telemetry.regression = true;
        results.push(r);
      } catch (e) {
        if (e instanceof EvaluationBudgetError) {
          status = controller.signal.aborted ? "CANCELLED" : "COMPLETED";
          stopReason = e.message;
          // Remaining cases are recorded as skipped — never as passes.
          for (const rest of dataset.cases.slice(dataset.cases.indexOf(c))) {
            results.push({
              caseId: rest.id, pass: false, score: 0, verdicts: [], skipped: true, skipReason: e.message,
              telemetry: { modelCalls: 0, toolCalls: 0, toolFailures: 0, refused: false, escalated: false },
            });
          }
          break;
        }
        throw e;
      }
    }
  } catch (e) {
    status = "FAILED";
    stopReason = (e as Error).message;
  } finally {
    clearTimeout(timer);
    controllers.delete(evaluation.id);
    running.set(input.companyId, Math.max(0, (running.get(input.companyId) ?? 1) - 1));
  }

  const finishedAt = new Date();
  const run = aggregateRun(
    {
      evaluationId: evaluation.id,
      agentKey: input.agentKey,
      workflow: "agent.turn",
      provider: "anthropic",
      model: evaluation.model,
      mode,
      promptId: template.key,
      promptVersion: String(version.version),
      toolSchemaVersion: TOOL_SCHEMA_VERSION,
      datasetId: dataset.id,
      datasetVersion: dataset.version,
      startedAt: evaluation.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    },
    results,
  );

  const caseById = new Map(dataset.cases.map((c) => [c.id, c]));
  await prisma.$transaction([
    prisma.evalResult.createMany({
      data: results.map((r) => {
        const c = caseById.get(r.caseId)!;
        return {
          evaluationId: evaluation.id,
          companyId: input.companyId,
          caseId: r.caseId,
          caseKind: c.kind,
          tags: JSON.stringify(c.tags ?? []),
          expected: JSON.stringify(redactDeep(c.expectation, 500)),
          actual: r.outputSummary ?? "",
          pass: r.pass,
          skipped: r.skipped ?? false,
          skipReason: r.skipReason ?? "",
          score: r.score,
          verdicts: JSON.stringify(redactDeep(r.verdicts, 500)),
          failureCategory: r.skipped ? null : r.failureCategory ?? null,
          tokensIn: r.tokensIn ?? 0,
          tokensOut: r.tokensOut ?? 0,
          cost: r.cost ?? 0,
          latencyMs: Math.round(r.latencyMs ?? 0),
          telemetry: JSON.stringify(r.telemetry),
        };
      }),
    }),
    prisma.evaluation.update({
      where: { id: evaluation.id },
      data: {
        status,
        total: run.total,
        passed: run.passed,
        failed: run.failed,
        skipped: run.skipped,
        passRate: run.passRate,
        avgScore: run.avgScore,
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
        cost: run.cost,
        avgLatencyMs: run.avgLatencyMs,
        p50LatencyMs: run.p50LatencyMs,
        p95LatencyMs: run.p95LatencyMs,
        failureCounts: JSON.stringify(run.failureCounts),
        finishedAt,
      },
    }),
  ]);

  await audit(
    input.companyId,
    input.createdBy,
    "EVALUATION_RUN",
    evaluation.id,
    `${template.key}@v${version.version} on ${dataset.id}@${dataset.version}: ${run.passed}/${run.total} (${mode})${stopReason ? ` stop=${stopReason}` : ""}`,
  );
  await emitEvent({
    companyId: input.companyId,
    type: "EVALUATION_COMPLETED",
    actor: input.agentKey,
    level: run.total && run.passRate === 1 ? "success" : "warning",
    message: `Evaluation ${dataset.id}@${dataset.version} v${version.version}: ${run.passed}/${run.total} passed${run.skipped ? `, ${run.skipped} skipped` : ""} (${mode})`,
    meta: { evaluationId: evaluation.id, passRate: run.passRate, mode },
  });

  return {
    evaluationId: evaluation.id,
    run,
    telemetry: Object.fromEntries(results.map((r) => [r.caseId, r.telemetry])),
    status,
    stopReason,
  };
}

export function cancelEvaluation(evaluationId: string): boolean {
  const c = controllers.get(evaluationId);
  if (!c) return false;
  c.abort();
  return true;
}

/** Load a persisted evaluation as an EvaluationRun (workspace-scoped). */
export async function loadEvaluationRun(companyId: string, evaluationId: string): Promise<EvaluationRun | null> {
  const e = await prisma.evaluation.findFirst({ where: { id: evaluationId, companyId }, include: { results: true } });
  if (!e) return null;
  const cases: CaseResult[] = e.results.map((r) => ({
    caseId: r.caseId,
    pass: r.pass,
    skipped: r.skipped,
    skipReason: r.skipReason,
    score: r.score,
    verdicts: JSON.parse(r.verdicts),
    failureCategory: (r.failureCategory ?? undefined) as CaseResult["failureCategory"],
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    cost: r.cost,
    latencyMs: r.latencyMs,
    outputSummary: r.actual,
  }));
  return aggregateRun(
    {
      evaluationId: e.id,
      agentKey: e.agentKey,
      workflow: e.workflow,
      provider: e.provider,
      model: e.model,
      mode: e.mode as "live" | "simulation",
      promptId: e.promptKey,
      promptVersion: String(e.promptVersion),
      toolSchemaVersion: e.toolSchemaVersion,
      datasetId: e.datasetId,
      datasetVersion: e.datasetVersion,
      startedAt: e.startedAt.toISOString(),
      finishedAt: (e.finishedAt ?? e.startedAt).toISOString(),
    },
    cases,
  );
}
