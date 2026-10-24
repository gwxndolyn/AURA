import { usageSummary, BUDGET } from "@/lib/ai/budget";
import { emitEvent } from "@/lib/events/emit";

/**
 * Loop + budget protection. Prevents runaway agent→tool→agent loops and
 * unbounded Claude spend. Callers check `guard()` before each agent turn and
 * stop when it returns a non-"ok" verdict.
 */

export interface GuardState {
  iterations: number;
  toolCalls: number;
  startedAt: number;
}

export const LIMITS = {
  maxIterations: Number(process.env.AURA_MAX_ITERATIONS ?? 25),
  maxToolCalls: Number(process.env.AURA_MAX_TOOL_CALLS ?? 60),
  maxRuntimeMs: Number(process.env.AURA_MAX_RUNTIME_MS ?? 180000),
};

export type GuardVerdict =
  | { ok: true }
  | { ok: false; reason: string; kind: "iterations" | "toolcalls" | "runtime" | "budget" };

export function newGuardState(): GuardState {
  return { iterations: 0, toolCalls: 0, startedAt: Date.now() };
}

/** Check loop limits synchronously (cheap). */
export function checkLoop(state: GuardState): GuardVerdict {
  if (state.iterations >= LIMITS.maxIterations)
    return { ok: false, reason: `iteration limit (${LIMITS.maxIterations}) exceeded`, kind: "iterations" };
  if (state.toolCalls >= LIMITS.maxToolCalls)
    return { ok: false, reason: `tool-call limit (${LIMITS.maxToolCalls}) exceeded`, kind: "toolcalls" };
  if (Date.now() - state.startedAt >= LIMITS.maxRuntimeMs)
    return { ok: false, reason: `runtime limit (${LIMITS.maxRuntimeMs}ms) exceeded`, kind: "runtime" };
  return { ok: true };
}

/** Check the daily AI budget (hits DB). Emits warnings at 80/90%. */
export async function checkBudget(companyId: string): Promise<GuardVerdict> {
  const u = await usageSummary(companyId);
  const pct = BUDGET.dailyUsd > 0 ? u.todayCost / BUDGET.dailyUsd : 0;
  if (pct >= 1) {
    await emitEvent({
      companyId,
      type: "AGENT_FAILED",
      actor: "ceo",
      level: "danger",
      message: `AI daily budget hard stop: $${u.todayCost.toFixed(2)} / $${BUDGET.dailyUsd}`,
    });
    return { ok: false, reason: "daily AI budget exceeded (hard stop)", kind: "budget" };
  }
  return { ok: true };
}

/** One-time warning emitter for 80%/90% thresholds (deduped per level in-memory). */
const warned = new Set<string>();
export async function maybeWarnBudget(companyId: string) {
  const u = await usageSummary(companyId);
  const pct = BUDGET.dailyUsd > 0 ? u.todayCost / BUDGET.dailyUsd : 0;
  for (const level of [0.9, 0.8]) {
    const key = `${companyId}:${level}`;
    if (pct >= level && !warned.has(key)) {
      warned.add(key);
      await emitEvent({
        companyId,
        type: "COMPANY_UPDATED",
        actor: "ceo",
        level: "warning",
        message: `AI budget warning: ${Math.round(pct * 100)}% of $${BUDGET.dailyUsd} daily budget used`,
      });
      break;
    }
  }
}
