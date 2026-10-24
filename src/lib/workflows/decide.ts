import { prisma } from "@/lib/db";
import { runAgent } from "@/lib/agents/orchestrator";
import { emitEvent } from "@/lib/events/emit";
import { parseJSON } from "@/lib/utils";

/** The AI CEO/decision engine answers a question grounded in real company state. */
export async function askCeo(companyId: string, question: string) {
  const run = await runAgent({
    companyId,
    agentKey: "ceo",
    objective: question,
    kind: "ceo",
    tier: "REASONING",
  });
  await emitEvent({
    companyId,
    type: "CHAT",
    actor: "ceo",
    message: `CEO answered: ${question.slice(0, 60)}`,
    persist: false,
  });
  return { answer: run.text, summary: run.summary, cost: run.cost, model: run.model };
}

/** Create and resolve a company decision with consulted agents + rationale. */
export async function makeDecision(companyId: string, question: string) {
  const run = await runAgent({
    companyId,
    agentKey: "ceo",
    objective: `Decide: ${question}`,
    kind: "decision",
    tier: "REASONING",
  });
  const parsed = parseJSON<{
    options: { label: string; pros: string[]; cons: string[] }[];
    choice: string;
    rationale: string;
  }>(run.text, { options: [], choice: "", rationale: run.text });

  const company = await prisma.company.findUnique({ where: { id: companyId } });
  const evidence = company
    ? [
        `Cash: $${Math.round(company.cash)}`,
        `Customers: ${company.customers}`,
        `Security score: ${company.securityScore}/100`,
        `Tech debt: ${company.technicalDebt}/100`,
      ]
    : [];

  const decision = await prisma.decision.create({
    data: {
      companyId,
      question,
      options: JSON.stringify(parsed.options),
      evidence: JSON.stringify(evidence),
      consulted: JSON.stringify(["ceo", "architect", "product-manager"]),
      choice: parsed.choice,
      rationale: parsed.rationale,
      status: "DECIDED",
    },
  });

  await emitEvent({
    companyId,
    type: "DECISION_CREATED",
    actor: "ceo",
    level: "info",
    message: `Decision: ${parsed.choice || question}`,
    meta: { decisionId: decision.id },
  });

  return decision;
}
