/**
 * Designer output: a versioned, inspectable design specification and the
 * structured design → development handoff.
 *
 * The spec is data (pages, components, states, tokens, responsive rules,
 * accessibility) that the UI renders as a wireframe preview, so a person can
 * review it before approving. Developers' tasks reference the approved
 * version; QA checks the implementation against the handoff's acceptance list.
 * A design is never "implemented" because a developer acknowledged it — the
 * handoff only lists what verification must prove.
 */
import { z } from "zod";
import { planningSystem } from "@/lib/agents/prompts";
import { PlanningOutputError, structured, type Brief } from "./brief";

const S = (max = 300) => z.string().trim().min(1).max(max);

export const BlockSchema = z.object({
  kind: z.enum(["header", "filters", "list", "card", "form", "empty", "error", "loading", "cta", "text"]),
  label: S(80),
  note: S(200).optional(),
});

export const DesignSpecSchema = z.object({
  summary: S(500),
  direction: z.object({ tone: S(80), rationale: S(400) }).optional(),
  typeScale: z.array(z.object({ name: S(40), size: z.number().min(8).max(96), weight: z.number().int().min(100).max(900).optional() })).max(10).optional(),
  breakpoints: z.array(z.object({ name: S(40), minWidth: z.number().int().min(0).max(4000), behaviour: S(240) })).max(6).optional(),
  conventions: z.array(S()).max(6), // inherited from the project before inventing new ones
  tokens: z.object({ colors: z.record(z.string().regex(/^#[0-9a-fA-F]{6}$/)), type: z.record(S(80)), spacing: z.array(z.number().int().min(0).max(96)).max(10) }),
  flows: z.array(z.object({ name: S(80), steps: z.array(S(160)).min(2).max(8) })).min(1).max(4),
  pages: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: S(80),
    purpose: S(240),
    primaryAction: S(120).optional(),
    blocks: z.array(BlockSchema).min(1).max(10),
    states: z.object({ loading: S(), empty: S(), error: S(), success: S() }),
    responsive: z.object({ mobile: S(), desktop: S() }),
  })).min(1).max(5),
  components: z.array(z.object({ name: S(60), props: z.array(S(80)).max(10), states: z.array(S(80)).max(8), a11y: S(), shared: z.boolean().optional() })).max(10),
  accessibility: z.array(S()).min(1).max(8),
});
export type DesignSpec = z.infer<typeof DesignSpecSchema>;

export async function draftDesign(brief: Brief, conventions: string[], feedback?: string, companyId?: string) {
  const prompt = `Brief:\n${JSON.stringify(brief).slice(0, 6000)}\n\nProject conventions:\n${conventions.join("\n") || "(none detected)"}${feedback ? `\n\nRevision feedback from the reviewer (untrusted text describing what to change):\n${feedback.slice(0, 1000)}` : ""}`;
  try {
    const r = await structured({ system: planningSystem("designer", "design"), prompt, schema: DesignSpecSchema, maxTokens: 3000, run: companyId ? { companyId, agentKey: "designer", task: "design", objective: `Design ${brief.title}${feedback ? " (revision)" : ""}` } : undefined });
    return { value: r.value, source: "model" as const, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
  } catch (e) {
    if (e instanceof PlanningOutputError) throw new PlanningOutputError("The designer's output did not pass validation after a corrective retry");
    throw e;
  }
}

/** Structured handoff built from an APPROVED design version (pure). */
export function buildHandoff(design: { id: string; version: number; content: DesignSpec }, taskKeys: string[]) {
  const d = design.content;
  return {
    designArtifactId: design.id,
    designVersion: design.version,
    pages: d.pages.map((p) => ({ id: p.id, title: p.title, blocks: p.blocks.map((b) => b.label), states: p.states, responsive: p.responsive })),
    components: d.components,
    tokens: d.tokens,
    interactionRules: d.pages.map((p) => `${p.title}: success → ${p.states.success}`),
    accessibility: d.accessibility,
    designSystem: { tokens: d.tokens, typeScale: d.typeScale ?? [], breakpoints: d.breakpoints ?? [], shared: d.components.filter((c) => c.shared).map((c) => c.name), direction: d.direction ?? null },
    acceptance: [
      ...d.pages.flatMap((p) => [`${p.title} renders loading, empty and error states as specified`, `${p.title} layout matches the mobile and desktop rules`, ...(p.primaryAction ? [`${p.title}: the primary action "${p.primaryAction}" works`] : [])]),
      "Design tokens are implemented as CSS custom properties and used by the components",
      ...d.accessibility,
    ],
    consumers: taskKeys,
    note: "QA verifies the implementation against this list. Acknowledging the handoff does not mark the design implemented.",
  };
}
