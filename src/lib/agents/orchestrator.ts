import { prisma } from "@/lib/db";
import { complete } from "@/lib/ai/claude";
import { getAgentDef } from "./definitions";
import { retrieveContext, remember } from "./memory";
import { emitEvent } from "@/lib/events/emit";
import { checkBudget, maybeWarnBudget } from "./guardrails";
import type { AgentStatus, ModelTier } from "@/lib/types";
import { resolveAgentPrompt } from "@/lib/intelligence/registry";
import { assessTaskSafety, PolicyRefusalError } from "@/lib/intelligence/policy";

/**
 * Agent orchestration. Runs a single agent "turn":
 *  1. set status THINKING, emit event
 *  2. build a focused context (role prompt + company snapshot + relevant memory)
 *  3. call Claude via the central abstraction (or simulation)
 *  4. record an AgentRun + token/cost usage
 *  5. store a short safe summary to memory
 *  6. set status back and emit completion
 *
 * We never expose hidden chain-of-thought — only a short safe summary.
 */

export interface RunAgentInput {
  companyId: string;
  agentKey: string;
  objective: string;
  kind?: string; // simulator hint & shapes expectations
  tier?: ModelTier; // override preferred tier
  context?: string; // extra inline context
  temperature?: number;
  simDay?: number;
  /**
   * Pre-assembled, provenance-tracked context (missions). When set, it replaces
   * the generic company snapshot + memory retrieval so the agent receives only
   * what its task needs.
   */
  assembledContext?: string;
  maxTokens?: number;
}

export interface RunAgentResult {
  runId: string;
  text: string;
  summary: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  latencyMs: number;
  model: string;
  mode: "live" | "simulation";
  tier: ModelTier;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usageSource: "provider" | "estimated";
  fallbackReason?: string;
}

async function setStatus(companyId: string, agentKey: string, status: AgentStatus, currentTask?: string | null) {
  await prisma.agent.update({
    where: { companyId_key: { companyId, key: agentKey } },
    data: { status, currentTask: currentTask === undefined ? undefined : currentTask },
  });
}

function safeSummary(text: string, def: { role: string }): string {
  // Never expose raw internal reasoning. For structured (JSON) outputs, derive
  // a human-readable summary instead of dumping the JSON.
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj.attackType && obj.target) return `Simulated ${obj.attackType} against ${obj.target}`;
      if (typeof obj.total === "number" && Array.isArray(obj.cases))
        return `Ran tests: ${obj.passed}/${obj.total} passed`;
      if (obj.strategy) return obj.strategy;
      if (obj.choice) return `Recommendation: ${obj.choice}`;
      if (obj.detectionMethod) return `Detected via ${obj.detectionMethod}; ${obj.containment ?? "contained"}`;
      return `${def.role} completed analysis`;
    } catch {
      /* fall through */
    }
  }
  const line = trimmed.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "Working.";
  return line.length > 140 ? line.slice(0, 137) + "..." : line;
}

export class BudgetExceededError extends Error {
  constructor() {
    super("Daily AI budget exceeded — agent execution paused");
    this.name = "BudgetExceededError";
  }
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const def = getAgentDef(input.agentKey);
  if (!def) throw new Error(`Unknown agent: ${input.agentKey}`);

  const agent = await prisma.agent.findUnique({
    where: { companyId_key: { companyId: input.companyId, key: input.agentKey } },
  });
  if (!agent) throw new Error(`Agent ${input.agentKey} not found for company`);

  // Budget hard-stop: never let agents burn past the daily budget.
  const budget = await checkBudget(input.companyId);
  if (!budget.ok) throw new BudgetExceededError();
  await maybeWarnBudget(input.companyId);

  // Deterministic safety pre-flight (enforced in code, measured by the
  // intelligence evaluations): offensive actions must stay inside the range.
  const safety = assessTaskSafety(input.objective, input.context);
  if (!safety.allowed) {
    await prisma.agentRun.create({
      data: {
        companyId: input.companyId, agentId: agent.id, objective: input.objective, model: "none", tier: input.tier ?? def.tier,
        status: "FAILED", summary: safety.reason, promptRef: "policy", failureCategory: "security_policy_violation",
      },
    });
    await emitEvent({ companyId: input.companyId, type: "AGENT_FAILED", actor: input.agentKey, level: "danger", message: safety.reason, simDay: input.simDay });
    throw new PolicyRefusalError(safety.reason);
  }

  const tier = input.tier ?? def.tier;
  // Use the workspace's ACTIVE registered prompt version (falls back to the
  // built-in definitions.ts prompt) and record which one was used.
  const prompt_ = await resolveAgentPrompt(input.companyId, input.agentKey);

  await setStatus(input.companyId, input.agentKey, "THINKING", input.objective);
  await emitEvent({
    companyId: input.companyId,
    type: "AGENT_STARTED",
    actor: input.agentKey,
    message: input.objective,
    simDay: input.simDay,
  });

  // Build focused context.
  const company = input.assembledContext ? null : await prisma.company.findUnique({ where: { id: input.companyId } });
  const memory = input.assembledContext ? [] : await retrieveContext(agent.id, input.objective);
  const snapshot = company
    ? `Company: ${company.name} — ${company.mission}\n` +
      `Status: ${company.status} | Customers: ${company.customers} | Revenue: $${Math.round(company.revenue)} | ` +
      `Cash: $${Math.round(company.cash)} | Security: ${company.securityScore}/100 | ` +
      `Uptime: ${company.uptime.toFixed(1)}% | Tech debt: ${company.technicalDebt}/100`
    : "";

  const system = prompt_.system || def.systemPrompt;
  const prompt = [
    snapshot && `# Company State\n${snapshot}`,
    memory.length ? `# Relevant memory\n${memory.join("\n")}` : "",
    input.assembledContext ?? "",
    input.context ? `# Context\n${input.context}` : "",
    `# Objective\n${input.objective}`,
    `\nSafety: all engineering, attacks and defenses are confined to the isolated AURA simulation.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  await emitEvent({
    companyId: input.companyId,
    type: "AGENT_THINKING",
    actor: input.agentKey,
    message: `${def.name} is analyzing: ${input.objective.slice(0, 80)}`,
    simDay: input.simDay,
    persist: false,
  });

  await setStatus(input.companyId, input.agentKey, "WORKING");

  const result = await complete({
    tier,
    system,
    prompt,
    kind: input.kind,
    seed: `${input.companyId}:${input.agentKey}:${input.objective}`,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
  });

  const summary = safeSummary(result.text, def);

  const run = await prisma.agentRun.create({
    data: {
      companyId: input.companyId,
      agentId: agent.id,
      objective: input.objective,
      model: result.model,
      tier,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      usageSource: result.usageSource,
      mode: result.mode,
      cost: result.cost,
      latencyMs: result.latencyMs,
      status: "COMPLETED",
      summary,
      promptVersionId: prompt_.promptVersionId,
      promptRef: prompt_.promptRef,
    },
  });

  await prisma.agent.update({
    where: { id: agent.id },
    data: {
      tokensIn: { increment: result.tokensIn },
      tokensOut: { increment: result.tokensOut },
      cost: { increment: result.cost },
      status: "COMPLETED",
      currentTask: null,
    },
  });

  await remember(agent.id, `[${input.kind ?? "task"}] ${summary}`, "short");

  await emitEvent({
    companyId: input.companyId,
    type: "AGENT_COMPLETED",
    actor: input.agentKey,
    level: "success",
    message: summary,
    simDay: input.simDay,
    meta: { tokensIn: result.tokensIn, tokensOut: result.tokensOut, cost: result.cost, model: result.model, mode: result.mode, ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}) },
  });

  // Return to idle shortly after (so UI shows COMPLETED briefly).
  await setStatus(input.companyId, input.agentKey, "IDLE");

  return {
    runId: run.id,
    text: result.text,
    summary,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    cost: result.cost,
    latencyMs: result.latencyMs,
    model: result.model,
    mode: result.mode,
    tier,
    cacheReadTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
    usageSource: result.usageSource,
    fallbackReason: result.fallbackReason,
  };
}

/** Record a tool call against a run (real tool-calling framework). */
export async function logToolCall(
  runId: string,
  tool: string,
  inputObj: unknown,
  outputObj: unknown,
  ok = true,
) {
  await prisma.toolCall.create({
    data: {
      runId,
      tool,
      input: JSON.stringify(inputObj ?? {}),
      output: JSON.stringify(outputObj ?? {}),
      ok,
    },
  });
}
