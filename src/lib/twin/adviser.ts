/**
 * AI adviser. Explains — it never computes simulation results. Input is the
 * structured comparison/review produced by the deterministic engine plus the
 * operational metrics; output must validate (facts with references,
 * assumptions, forecasts, recommendations, uncertainties) and may cite only
 * known run ids / metric keys. Without a model (or on invalid output) the
 * deterministic explanation is returned. Advice never triggers an action.
 */
import { z } from "zod";
import { complete, aiMode } from "@/lib/ai/claude";
import { extractJson } from "@/lib/agents/contracts";

const Schema = z.object({
  facts: z.array(z.object({ text: z.string().min(3).max(300), refs: z.array(z.string()).min(1).max(5) })).max(8),
  assumptions: z.array(z.string().max(300)).max(6),
  forecasts: z.array(z.string().max(300)).max(4),
  recommendations: z.array(z.string().max(300)).max(4),
  uncertainties: z.array(z.string().max(300)).max(4),
});
export type Advice = z.infer<typeof Schema>;

export async function advise(input: { question: string; comparison: unknown; review: string[]; operational: { key: string; value: number | null }[]; knownRefs: string[] }) {
  const deterministic = { mode: "deterministic" as const, explanation: input.review, note: aiMode() === "live" ? "" : "No API key: showing the engine's own explanation." };
  if (aiMode() !== "live") return deterministic;
  const r = await complete({
    tier: "FAST",
    system: "You advise the CEO of a SIMULATED software company. Results were computed by a deterministic engine; do not change or invent numbers. Every fact must cite at least one ref from the provided list. Separate facts, simulation assumptions, forecasts (label as estimates), recommendations and uncertainties. Never claim any action was executed. Reply with one JSON object {facts:[{text,refs}],assumptions:[],forecasts:[],recommendations:[],uncertainties:[]}.",
    prompt: `# Question\n${input.question.slice(0, 500)}\n\n# Engine comparison (authoritative)\n${JSON.stringify(input.comparison).slice(0, 12000)}\n\n# Engine review\n${input.review.join("\n")}\n\n# Operational metrics (real)\n${JSON.stringify(input.operational)}\n\n# Allowed refs\n${input.knownRefs.join(", ")}`,
    maxTokens: 900,
    temperature: 0,
  });
  const p = Schema.safeParse(extractJson(r.text));
  if (!p.success) return { ...deterministic, note: "The adviser's output failed validation; showing the engine's explanation." };
  const bad = p.data.facts.flatMap((f) => f.refs).filter((x) => !input.knownRefs.includes(x));
  if (bad.length) return { ...deterministic, note: `The adviser cited unknown references (${bad.slice(0, 3).join(", ")}); showing the engine's explanation.` };
  return { mode: "ai" as const, advice: p.data, model: r.model, costUsd: r.cost, note: "AI interpretation of engine results. The engine's numbers are authoritative." };
}
