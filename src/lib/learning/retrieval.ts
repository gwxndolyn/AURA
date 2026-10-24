/**
 * Learning context for one engineering task: a small, explainable package.
 *
 * Sources (all scoped to the task's workspace + product; never another tenant):
 *   project memory   VERIFIED facts and labelled ASSUMPTIONs (factory/memory.ts);
 *                    entries whose files changed are STALE and excluded; an entry
 *                    about a file is dropped when the file no longer exists
 *   negative memory  approaches that failed before for this task/files ("failed:")
 *   attributions     established root causes of earlier failed attempts of the
 *                    same task (so a repair does not repeat a failed approach)
 *   recipes          applicable platform/workspace recipes with their real
 *                    validation status and application counts
 *   feedback         the user's active corrections for this product/workspace
 *
 * Every item is labelled by epistemic status so the agent can tell
 *   CURRENT FACT (verified, current code) · PRIOR DECISION · HISTORY ·
 *   RECOMMENDATION (recipe / hypothesis) · USER INSTRUCTION
 * and a manifest records what was retrieved and why (no content, only refs).
 * Current code and explicit current requirements take precedence: the text
 * says so, and stale/contradicted memory is never included.
 *
 * Failure-tolerant: any error returns an empty package (delivery continues).
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { log } from "@/lib/observability/log";
import { retrieve } from "@/lib/factory/memory";
import { recipesFor, renderRecipe, recipeStats } from "./recipes";
import { feedbackFor, markApplied, type FeedbackAction } from "./feedback";

export interface ManifestEntry { source: "memory" | "negative" | "attribution" | "recipe" | "feedback"; ref: string; label: string; status: string; reason: string }

export interface LearningContext {
  text: string;
  manifest: ManifestEntry[];
  criteria: string[]; // acceptance criteria added by explicit user feedback
  reviewerInstructions: string[];
  browserRequired: boolean;
  scopeStrict: boolean;
  recipeIds: string[];
}

const EMPTY: LearningContext = { text: "", manifest: [], criteria: [], reviewerInstructions: [], browserRequired: false, scopeStrict: false, recipeIds: [] };

export async function learningContext(args: { companyId: string; productId: string; buildId: string; itemKey: string; kind: string; stack: string; title: string; description: string; acceptance: string[]; files: string[]; requirements: string[]; signatures: string[]; currentFiles: string[]; failureCategories: string[]; budgetChars?: number }): Promise<LearningContext> {
  try {
    const manifest: ManifestEntry[] = [];
    const current = new Set(args.currentFiles);
    const text = `${args.title} ${args.description} ${args.acceptance.join(" ")}`;
    // 1. Project memory (facts + assumptions), excluding entries about files that no longer exist.
    const mem = (await retrieve(args.companyId, args.productId, { files: args.files, requirements: args.requirements, signatures: args.signatures, text, budgetChars: 2500, limit: 10 }))
      .filter((m) => !m.files.length || m.files.some((f) => current.has(f) || f === "package.json"));
    const negative = mem.filter((m) => m.key.startsWith("failed:"));
    const facts = mem.filter((m) => !m.key.startsWith("failed:") && m.status === "VERIFIED");
    const assumptions = mem.filter((m) => m.status === "ASSUMPTION");
    for (const m of facts) manifest.push({ source: "memory", ref: m.id, label: m.key, status: m.kind === "approved_decision" ? "PRIOR DECISION" : "CURRENT FACT", reason: m.files.some((f) => args.files.includes(f)) ? "about this task's files" : m.requirements.some((r) => args.requirements.includes(r)) ? "about this task's requirements" : m.kind === "defect_solution" ? "solved a failure with the same signature" : "project convention" });
    for (const m of assumptions) manifest.push({ source: "memory", ref: m.id, label: m.key, status: "ASSUMPTION", reason: "unverified project assumption" });
    for (const m of negative) manifest.push({ source: "negative", ref: m.id, label: m.key, status: "HISTORY", reason: "an approach that failed before for this task" });
    // 2. Established root causes of earlier attempts of THIS task (repairs must not repeat them).
    const attrs = await prisma.failureAttribution.findMany({ where: { companyId: args.companyId, productId: args.productId, itemKey: args.itemKey, status: "ESTABLISHED", scope: { in: ["agent", "workflow"] } }, orderBy: { createdAt: "desc" }, take: 5 });
    for (const a of attrs) manifest.push({ source: "attribution", ref: a.id, label: `${a.category} (attempt ${a.attempt + 1})`, status: "HISTORY", reason: `verification of its fix: ${a.verification.toLowerCase()}` });
    // 3. Applicable recipes (applicability checked; validation status is real).
    const recipes = await recipesFor(args.companyId, { stack: args.stack, kind: args.kind, text, failureCategories: args.failureCategories });
    const recipeParts: string[] = [];
    for (const { r, a } of recipes) {
      const st = await recipeStats(r.id, r.scope === "platform" ? undefined : args.companyId);
      recipeParts.push(renderRecipe(r, st));
      manifest.push({ source: "recipe", ref: r.id, label: `${r.key}@v${r.version}`, status: `RECOMMENDATION (${r.status.toLowerCase()})`, reason: a.reason });
    }
    // 4. Explicit user feedback for this product/workspace.
    const fb = await feedbackFor(args.companyId, args.productId);
    const actions: (FeedbackAction & { id: string })[] = fb.flatMap((f) => f.actions.map((a) => ({ ...a, id: f.id })));
    for (const f of fb) manifest.push({ source: "feedback", ref: f.id, label: f.kind, status: "USER INSTRUCTION", reason: f.scope === "workspace" ? "workspace-wide preference" : "correction on this product" });
    await markApplied(fb.map((f) => f.id));

    const line = (m: { kind: string; content: string; provenance: { type: string; ref: string } }) => `- [${m.kind}] ${m.content} (source: ${m.provenance.type} ${m.provenance.ref.slice(-8)})`;
    const sections = [
      "Precedence: the current repository and the current task's requirements override anything below. If memory contradicts the code you read, trust the code and say so in your summary.",
      facts.length ? `## CURRENT FACTS (verified by executed evidence or approved by a person)\n${facts.map(line).join("\n")}` : "",
      assumptions.length ? `## ASSUMPTIONS (not verified — confirm in the code)\n${assumptions.map(line).join("\n")}` : "",
      negative.length || attrs.length ? `## WHAT FAILED BEFORE (do not repeat unchanged)\n${[...negative.map(line), ...attrs.map((a) => `- attempt ${a.attempt + 1}: ${a.category} — ${a.rootCause} → tried: ${a.correctiveAction} (${a.verification.toLowerCase()})`)].join("\n")}` : "",
      recipeParts.length ? `## RECOMMENDATIONS (recipes; check they fit this repository)\n${recipeParts.join("\n\n")}` : "",
      actions.filter((a) => a.type === "instruction" || a.type === "rework").length ? `## USER INSTRUCTIONS (explicit corrections from the user)\n${actions.filter((a) => a.type === "instruction" || a.type === "rework").map((a) => `- ${a.detail}`).join("\n")}` : "",
    ].filter(Boolean);
    const body = sections.length > 1 ? sections.join("\n\n").slice(0, args.budgetChars ?? 7000) : "";
    return {
      text: body,
      manifest,
      criteria: [...new Set(actions.filter((a) => a.type === "criterion").map((a) => a.detail))],
      reviewerInstructions: [...new Set(actions.filter((a) => a.type === "reviewer_instruction").map((a) => a.detail))],
      browserRequired: actions.some((a) => a.type === "browser_required"),
      scopeStrict: actions.some((a) => a.type === "scope_strict"),
      recipeIds: recipes.map((x) => x.r.id),
    };
  } catch (e) {
    log("warn", "learning.retrieval_failed", { buildId: args.buildId, error: (e as Error).message });
    return EMPTY;
  }
}

/** Record which recipes a run used (outcome filled in when the run finishes). */
export async function recordRecipeUse(companyId: string, productId: string, buildId: string, itemKey: string, recipeIds: string[]) {
  for (const id of recipeIds) await prisma.recipeApplication.upsert({ where: { recipeId_buildId: { recipeId: id, buildId } }, create: { recipeId: id, companyId, productId, buildId, itemKey }, update: {} }).catch(() => null);
}

export function parseManifest(raw: string) {
  return parseJSON<ManifestEntry[]>(raw, []);
}
