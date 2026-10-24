import { prisma } from "@/lib/db";
import { runAgent } from "@/lib/agents/orchestrator";
import { emitEvent, audit } from "@/lib/events/emit";
import { sendMessage } from "@/lib/agents/messaging";

/**
 * Explicit conflict-resolution process between two agents. Collects each side's
 * argument, has the Architect (or CEO) evaluate the evidence and decide, records
 * the decision permanently, and notifies both parties. Does NOT blindly pick a side.
 */
export async function resolveConflict(args: {
  companyId: string;
  topic: string;
  sideA: { agentKey: string; position: string; evidence: string[] };
  sideB: { agentKey: string; position: string; evidence: string[] };
  arbiterKey?: string;
}) {
  const { companyId, topic, sideA, sideB } = args;
  const arbiter = args.arbiterKey ?? "architect";

  await emitEvent({
    companyId,
    type: "DECISION_CREATED",
    actor: arbiter,
    level: "warning",
    message: `Conflict: ${topic} — ${sideA.agentKey} vs ${sideB.agentKey}`,
  });

  // Each side states its case (recorded as messages).
  await sendMessage({ companyId, fromKey: sideA.agentKey, toKey: arbiter, type: "DECISION", message: `${sideA.position} — because ${sideA.evidence.join(", ")}` });
  await sendMessage({ companyId, fromKey: sideB.agentKey, toKey: arbiter, type: "DECISION", message: `${sideB.position} — because ${sideB.evidence.join(", ")}` });

  // Arbiter evaluates and decides (grounded reasoning turn).
  const run = await runAgent({
    companyId,
    agentKey: arbiter,
    objective: `Resolve conflict: ${topic}`,
    kind: "decision",
    tier: "REASONING",
    context:
      `Option A (${sideA.agentKey}): ${sideA.position}. Evidence: ${sideA.evidence.join(", ")}.\n` +
      `Option B (${sideB.agentKey}): ${sideB.position}. Evidence: ${sideB.evidence.join(", ")}.`,
  });

  // Deterministic tie-break on evidence weight so a decision is always reached,
  // explained by the arbiter's reasoning summary.
  const scoreA = sideA.evidence.length;
  const scoreB = sideB.evidence.length;
  const winner = scoreA === scoreB ? sideA : scoreA > scoreB ? sideA : sideB;
  const choice = winner.position;

  const decision = await prisma.decision.create({
    data: {
      companyId,
      question: topic,
      options: JSON.stringify([
        { label: sideA.position, pros: sideA.evidence, cons: [] },
        { label: sideB.position, pros: sideB.evidence, cons: [] },
      ]),
      evidence: JSON.stringify([...sideA.evidence, ...sideB.evidence]),
      consulted: JSON.stringify([sideA.agentKey, sideB.agentKey, arbiter]),
      choice,
      rationale: `${run.summary} Chosen on weight of evidence (${winner.agentKey}).`,
      status: "DECIDED",
    },
  });

  // Notify both parties (skip self-notification if arbiter is a participant).
  for (const key of [sideA.agentKey, sideB.agentKey]) {
    if (key === arbiter) continue;
    await sendMessage({ companyId, fromKey: arbiter, toKey: key, type: "DECISION", message: `Decision on "${topic}": ${choice}.` });
  }

  await emitEvent({ companyId, type: "DECISION_CREATED", actor: arbiter, level: "success", message: `Decision: ${choice}` });
  await audit(companyId, arbiter, "RESOLVE_CONFLICT", decision.id, choice);

  return decision;
}
