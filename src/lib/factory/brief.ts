/**
 * Product Manager output: product brief + initial backlog.
 *
 * The PM model drafts the brief and backlog through claude.ts (strict: no
 * simulated substitute). Output must pass BriefSchema / BacklogDraftSchema and
 * the dependency checks, with one corrective retry. `templateBrief` /
 * `templateBacklog` are deterministic fixtures for automated tests only.
 *
 * The initial backlog is deliberately small (≤ 3 epics, ≤ 12 tasks) and is
 * refined as execution reveals information. Only tasks backed by a real
 * codebase + test suite are marked `executable`.
 */
import { z } from "zod";
import { complete } from "@/lib/ai/claude";
import { extractJson } from "@/lib/agents/contracts";
import { validateGraph } from "./lifecycle";

const S = (max = 400) => z.string().trim().min(2).max(max);

export const BriefSchema = z.object({
  title: S(90),
  problem: S(800),
  personas: z.array(z.object({ name: S(60), needs: z.array(S(200)).min(1).max(5) })).min(1).max(4),
  outcomes: z.array(S()).min(1).max(6),
  functional: z.array(z.object({ id: z.string().regex(/^FR-\d+$/), text: S() })).min(1).max(12),
  nonFunctional: z.array(z.object({ id: z.string().regex(/^NFR-\d+$/), text: S() })).max(8),
  mvp: z.array(S()).min(1).max(8),
  outOfScope: z.array(S()).max(8),
  journeys: z.array(z.object({ name: S(80), steps: z.array(S(200)).min(2).max(8) })).min(1).max(4),
  acceptance: z.array(z.object({ id: z.string().regex(/^AC-\d+$/), text: S(), measurable: z.boolean() })).min(1).max(12),
  assumptions: z.array(z.object({ id: z.string().regex(/^A-\d+$/), text: S(), editable: z.literal(true) })).max(10),
  risks: z.array(S()).max(8),
  questions: z.array(z.object({ text: S(), material: z.boolean(), default: S(300) })).max(6),
  milestones: z.array(z.object({ id: z.string().regex(/^M\d+$/), name: S(80), goal: S(300) })).min(1).max(4),
});
export type Brief = z.infer<typeof BriefSchema>;

export const BacklogDraftSchema = z.object({
  epics: z.array(z.object({
    key: z.string().regex(/^E\d+$/),
    title: S(120),
    stories: z.array(z.object({
      key: z.string().regex(/^E\d+\.S\d+$/),
      title: S(160),
      acceptance: z.array(S()).min(1).max(6),
      milestone: z.string().regex(/^M\d+$/),
      tasks: z.array(z.object({
        key: z.string().regex(/^E\d+\.S\d+\.T\d+$/),
        title: S(160),
        description: S(800),
        kind: z.enum(["DESIGN", "ARCHITECTURE", "FRONTEND", "BACKEND", "DATA", "TEST", "DOCS"]),
        acceptance: z.array(S()).min(1).max(6),
        dependsOn: z.array(z.string()).max(6),
        effort: z.number().int().min(1).max(13),
        risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
        files: z.array(z.string().max(200)).max(8),
        // Brief requirement ids this task implements (traceability); validated against the brief.
        requirements: z.array(z.string().regex(/^(FR|NFR|AC)-\d+$/)).max(8).default([]),
      })).min(1).max(6),
    })).min(1).max(5),
  })).min(1).max(3),
});
export type BacklogDraft = z.infer<typeof BacklogDraftSchema>;

/** Requirement ids defined by a brief (FR-n, NFR-n, AC-n). */
export function requirementIds(b: Pick<Brief, "functional" | "nonFunctional" | "acceptance">) {
  return [...b.functional, ...b.nonFunctional, ...b.acceptance].map((r) => r.id);
}

/** Requirement ids whose text changed, appeared or disappeared between two briefs. */
export function changedRequirements(prev: Brief, next: Brief) {
  const map = (b: Brief) => new Map([...b.functional, ...b.nonFunctional, ...b.acceptance].map((r) => [r.id, r.text.trim()]));
  const a = map(prev), b = map(next);
  const changed = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k));
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  return { changed, added, removed, any: changed.length + added.length + removed.length > 0 };
}

/** Agent capabilities each task kind needs (matched against the real registry). */
export const KIND_AGENTS: Record<string, string[]> = {
  DESIGN: ["designer"],
  ARCHITECTURE: ["architect"],
  FRONTEND: ["frontend-engineer"],
  BACKEND: ["backend-engineer"],
  DATA: ["backend-engineer"],
  TEST: ["qa-engineer"],
  DOCS: ["product-manager"],
};

/** Verification each kind requires before it can count as verified. */
export const KIND_VERIFY: Record<string, string[]> = {
  DESIGN: ["design approved by a person"],
  ARCHITECTURE: ["architecture decision recorded"],
  FRONTEND: ["sandbox tests", "code review"],
  BACKEND: ["sandbox tests", "code review"],
  DATA: ["sandbox tests", "code review"],
  TEST: ["sandbox tests"],
  DOCS: ["reviewed by a person"],
};

export function validateBacklog(b: BacklogDraft, brief?: Brief): string[] {
  const flat = b.epics.flatMap((e) => e.stories.flatMap((s) => s.tasks.map((t) => ({ key: t.key, dependsOn: t.dependsOn }))));
  const errors = validateGraph(flat);
  const keys = flat.map((f) => f.key);
  if (new Set(keys).size !== keys.length) errors.push("duplicate task keys");
  if (flat.length > 12) errors.push("initial backlog is limited to 12 tasks; refine it as work proceeds");
  if (brief) {
    const ids = new Set(requirementIds(brief));
    for (const t of b.epics.flatMap((e) => e.stories.flatMap((s) => s.tasks))) for (const r of t.requirements ?? []) if (!ids.has(r)) errors.push(`${t.key} references unknown requirement ${r}`);
  }
  return errors;
}

export interface Drafted<T> { value: T; source: "model"; model: string; costUsd: number; tokensIn: number; tokensOut: number; attempts: number }

/**
 * Ask the model for JSON matching `schema`; on invalid output, retry once with
 * the validation errors. Strict provider: no key / provider failure throws a
 * ProviderError (the planning job retries or fails honestly). There is no
 * template substitute in production.
 */
export async function structured<T>(args: { system: string; prompt: string; schema: z.ZodType<T, z.ZodTypeDef, unknown>; extra?: (v: T) => string[]; maxTokens: number }): Promise<Drafted<T>> {
  let prompt = args.prompt;
  const acc = { cost: 0, tin: 0, tout: 0, model: "" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await complete({ tier: "STANDARD", system: args.system, prompt, maxTokens: args.maxTokens, temperature: 0.2, strict: true });
    acc.cost += r.cost;
    acc.tin += r.tokensIn;
    acc.tout += r.tokensOut;
    acc.model = r.model;
    const p = args.schema.safeParse(extractJson(r.text));
    const errs = p.success ? (args.extra?.(p.data) ?? []) : p.error.errors.slice(0, 8).map((e) => `${e.path.join(".")}: ${e.message}`);
    if (p.success && !errs.length) return { value: p.data, source: "model", model: acc.model, costUsd: acc.cost, tokensIn: acc.tin, tokensOut: acc.tout, attempts: attempt };
    prompt = `${args.prompt}\n\nYour previous reply was rejected by validation:\n${errs.join("\n")}\nReply again with ONE corrected JSON object only.`;
  }
  throw new PlanningOutputError("The model's plan did not pass validation after a corrective retry");
}

export class PlanningOutputError extends Error {
  retryable = false;
  kind = "invalid_model_output";
}

export async function draftBrief(idea: string): Promise<Drafted<Brief>> {
  return structured({
    system: "You are the Product Manager of an AI engineering team. Turn the idea into a concise, testable product brief for a web application. Use sensible reversible defaults and record each as an editable assumption; only flag a question as material if it changes scope, data handling, security, cost, architecture or UX. Reply with ONE JSON object matching the requested shape. No prose.",
    prompt: `Idea:\n${idea.slice(0, 2000)}\n\nShape: {title, problem, personas:[{name,needs[]}], outcomes[], functional:[{id:"FR-1",text}], nonFunctional:[{id:"NFR-1",text}], mvp[], outOfScope[], journeys:[{name,steps[]}], acceptance:[{id:"AC-1",text,measurable}], assumptions:[{id:"A-1",text,editable:true}], risks[], questions:[{text,material,default}], milestones:[{id:"M1",name,goal}]}`,
    schema: BriefSchema,
    maxTokens: 3000,
  });
}

export async function draftBacklog(brief: Brief, stackConventions: string): Promise<Drafted<BacklogDraft>> {
  return structured({
    system: "You are the Product Manager. Produce a SMALL initial backlog (≤3 epics, ≤12 tasks) for the MVP milestone only, for the given codebase conventions. Order work so each task is independently buildable and testable: data/API (BACKEND) before UI (FRONTEND) that depends on it. Every task needs concrete, testable acceptance criteria, dependencies (task keys), an effort ESTIMATE in points, a risk level, the files it will likely touch, and the brief requirement ids (FR-n / NFR-n / AC-n) it implements. Reply with ONE JSON object {epics:[{key:'E1',title,stories:[{key:'E1.S1',title,acceptance[],milestone:'M1',tasks:[{key:'E1.S1.T1',title,description,kind,acceptance[],dependsOn[],effort,risk,files[],requirements[]}]}]}]}. kind ∈ DESIGN|ARCHITECTURE|FRONTEND|BACKEND|DATA|TEST|DOCS. Include at most one DESIGN task.",
    prompt: `# Codebase conventions\n${stackConventions}\n\n# Brief\n${JSON.stringify(brief).slice(0, 8000)}`,
    schema: BacklogDraftSchema,
    extra: (v) => validateBacklog(v, brief),
    maxTokens: 4000,
  });
}
