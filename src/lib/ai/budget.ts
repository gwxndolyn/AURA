import { prisma } from "@/lib/db";

/**
 * AI budget manager. Tracks token/cost usage and enforces soft limits.
 * Limits are configurable via env; defaults are generous for local use.
 */
export const BUDGET = {
  dailyUsd: Number(process.env.AURA_DAILY_BUDGET_USD ?? 25),
  maxTaskUsd: Number(process.env.AURA_MAX_TASK_USD ?? 2),
  maxAgentTurns: Number(process.env.AURA_MAX_AGENT_TURNS ?? 6),
};

export async function usageSummary(companyId: string) {
  const runs = await prisma.agentRun.findMany({
    where: { companyId },
    select: { tokensIn: true, tokensOut: true, cost: true, agentId: true, createdAt: true },
  });

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  let todayCost = 0;
  const byAgent: Record<string, number> = {};

  for (const r of runs) {
    tokensIn += r.tokensIn;
    tokensOut += r.tokensOut;
    cost += r.cost;
    byAgent[r.agentId] = (byAgent[r.agentId] ?? 0) + r.cost;
    if (r.createdAt >= startOfDay) todayCost += r.cost;
  }

  return {
    tokensIn,
    tokensOut,
    totalTokens: tokensIn + tokensOut,
    cost,
    todayCost,
    byAgent,
    runs: runs.length,
    dailyBudget: BUDGET.dailyUsd,
    dailyRemaining: Math.max(0, BUDGET.dailyUsd - todayCost),
    overBudget: todayCost >= BUDGET.dailyUsd,
  };
}
