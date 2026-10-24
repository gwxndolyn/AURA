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
import { complete } from "@/lib/ai/claude";
import { extractJson } from "@/lib/agents/contracts";
import { PlanningOutputError, type Brief } from "./brief";

const S = (max = 300) => z.string().trim().min(1).max(max);

export const BlockSchema = z.object({
  kind: z.enum(["header", "filters", "list", "card", "form", "empty", "error", "loading", "cta", "text"]),
  label: S(80),
  note: S(200).optional(),
});

export const DesignSpecSchema = z.object({
  summary: S(500),
  conventions: z.array(S()).max(6), // inherited from the project before inventing new ones
  tokens: z.object({ colors: z.record(z.string().regex(/^#[0-9a-fA-F]{6}$/)), type: z.record(S(80)), spacing: z.array(z.number().int().min(0).max(96)).max(10) }),
  flows: z.array(z.object({ name: S(80), steps: z.array(S(160)).min(2).max(8) })).min(1).max(4),
  pages: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: S(80),
    purpose: S(240),
    blocks: z.array(BlockSchema).min(1).max(10),
    states: z.object({ loading: S(), empty: S(), error: S(), success: S() }),
    responsive: z.object({ mobile: S(), desktop: S() }),
  })).min(1).max(5),
  components: z.array(z.object({ name: S(60), props: z.array(S(80)).max(10), states: z.array(S(80)).max(8), a11y: S() })).max(10),
  accessibility: z.array(S()).min(1).max(8),
});
export type DesignSpec = z.infer<typeof DesignSpecSchema>;

export async function draftDesign(brief: Brief, conventions: string[], feedback?: string) {
  let prompt = `Brief:\n${JSON.stringify(brief).slice(0, 6000)}\n\nProject conventions:\n${conventions.join("\n") || "(none detected)"}${feedback ? `\n\nRevision feedback from the reviewer:\n${feedback.slice(0, 1000)}` : ""}`;
  let cost = 0;
  for (let i = 0; i < 2; i++) {
    const r = await complete({
      tier: "STANDARD",
      system: "You are the UX/UI Designer. Produce an implementable design spec as ONE JSON object: {summary, conventions[], tokens:{colors:{name:'#rrggbb'},type:{},spacing:[]}, flows:[{name,steps[]}], pages:[{id,title,purpose,blocks:[{kind,label,note?}],states:{loading,empty,error,success},responsive:{mobile,desktop}}], components:[{name,props[],states[],a11y}], accessibility[]}. block kind ∈ header|filters|list|card|form|empty|error|loading|cta|text. Follow listed project conventions first.",
      prompt,
      maxTokens: 3000,
      temperature: 0.3,
      strict: true,
    });
    cost += r.cost;
    const p = DesignSpecSchema.safeParse(extractJson(r.text));
    if (p.success) return { value: p.data, source: "model" as const, costUsd: cost };
    prompt += `\n\nYour previous reply failed validation: ${p.error.errors.slice(0, 5).map((e) => `${e.path.join(".")} ${e.message}`).join("; ")}. Reply with corrected JSON only.`;
  }
  throw new PlanningOutputError("The designer's output did not pass validation after a corrective retry");
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
    acceptance: [
      ...d.pages.flatMap((p) => [`${p.title} renders loading, empty and error states as specified`, `${p.title} layout matches the mobile and desktop rules`]),
      ...d.accessibility,
    ],
    consumers: taskKeys,
    note: "QA verifies the implementation against this list. Acknowledging the handoff does not mark the design implemented.",
  };
}
