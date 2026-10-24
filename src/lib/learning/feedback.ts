/**
 * Explicit user feedback → concrete, traceable actions.
 *
 * A correction is classified (deterministic rules over the user's own words)
 * into actions that change what AURA does next — not just stored text:
 *
 *   intent_mismatch  "this is not what I meant"   → rework requested, requirement
 *                    clarification criterion; the run's outcome is marked rework
 *   responsive       "mobile layout is broken"     → acceptance criterion "works at
 *                    390px without horizontal scrolling" + browser verification
 *   scope            "you changed unrelated files" → strict scope instruction; files
 *                    outside the plan are reported as blocking findings
 *   complexity       "too much complexity"         → simplicity instruction + reviewer
 *                    instruction to flag unnecessary abstraction
 *   accessibility    labels/keyboard/contrast      → a11y criterion
 *   quality          generic dissatisfaction       → rework requested
 *
 * Scope: product (default) or workspace (only when the user says so, e.g.
 * "always", "for all projects"). Feedback never crosses workspaces, can be
 * disabled or deleted by the user, and `appliedCount` records actual use — it
 * is never presented as an improvement until an evaluation shows one.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { audit } from "@/lib/events/emit";
import { redactText } from "@/lib/security/redact";

export const FEEDBACK_KINDS = ["intent_mismatch", "responsive", "scope", "complexity", "accessibility", "quality", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface FeedbackAction { type: "criterion" | "instruction" | "reviewer_instruction" | "browser_required" | "scope_strict" | "rework"; detail: string }

const RULES: { kind: FeedbackKind; re: RegExp; actions: FeedbackAction[] }[] = [
  { kind: "intent_mismatch", re: /not what i (meant|asked|wanted)|misunderst|wrong (feature|thing)|that'?s not it/i, actions: [{ type: "rework", detail: "The delivered behaviour does not match the user's intent; re-read the request and the user's correction before changing code." }, { type: "instruction", detail: "Before implementing, restate the user's intent in one sentence in your summary and implement exactly that." }] },
  { kind: "responsive", re: /mobile|responsive|small screen|phone|tablet|overflow|layout (is )?broken/i, actions: [{ type: "criterion", detail: "The page works at 390px width without horizontal scrolling or clipped controls" }, { type: "browser_required", detail: "Browser verification at desktop and mobile viewports is required for this task" }] },
  { kind: "scope", re: /unrelated files?|didn'?t ask|touched|changed (other|too many)|scope/i, actions: [{ type: "scope_strict", detail: "Change only the files the task names (plus their tests); files outside that set are blocking findings" }, { type: "instruction", detail: "Do not modify files unrelated to the task. If another file must change, explain why in your summary." }] },
  { kind: "complexity", re: /too (much )?complex|over-?engineer|simpler|too many (abstractions|layers)|bloat/i, actions: [{ type: "instruction", detail: "Prefer the simplest implementation that satisfies the criteria; no new abstractions, layers or dependencies unless required." }, { type: "reviewer_instruction", detail: "Flag unnecessary abstraction, indirection and new dependencies as findings (medium, blocking if they add a dependency)." }] },
  { kind: "accessibility", re: /accessib|screen reader|keyboard|label|contrast|a11y/i, actions: [{ type: "criterion", detail: "Every control has an accessible name, fields have labels, and the flow works with the keyboard" }, { type: "browser_required", detail: "Browser verification is required for this task" }] },
  { kind: "quality", re: /doesn'?t work|broken|bug|wrong|fails?|bad/i, actions: [{ type: "rework", detail: "The user reports the result does not work; reproduce from the user's description first." }] },
];

export function classifyFeedback(text: string): { kind: FeedbackKind; actions: FeedbackAction[]; workspaceScope: boolean } {
  const t = text.trim();
  const workspaceScope = /\b(always|in (all|every) (projects?|products?)|from now on|for all)\b/i.test(t);
  const hit = RULES.filter((r) => r.re.test(t));
  if (!hit.length) return { kind: "other", actions: [{ type: "instruction", detail: `User guidance (verbatim, untrusted text): "${t.slice(0, 300)}"` }], workspaceScope };
  const actions = hit.flatMap((h) => h.actions);
  const seen = new Set<string>();
  return { kind: hit[0].kind, actions: actions.filter((a) => (seen.has(a.detail) ? false : (seen.add(a.detail), true))), workspaceScope };
}

export async function recordFeedback(args: { companyId: string; userId: string; actor: string; text: string; productId?: string | null; itemKey?: string | null; buildId?: string | null }) {
  const text = redactText(args.text.trim()).slice(0, 2000);
  if (text.length < 3) throw new ApiError("Describe what should change", 422);
  if (args.productId && !(await prisma.product.findFirst({ where: { id: args.productId, companyId: args.companyId }, select: { id: true } }))) throw new ApiError("Product not found", 404);
  if (args.buildId && !(await prisma.build.findFirst({ where: { id: args.buildId, companyId: args.companyId }, select: { id: true } }))) throw new ApiError("Run not found", 404);
  const c = classifyFeedback(text);
  const scope = c.workspaceScope || !args.productId ? "workspace" : "product";
  const fb = await prisma.userFeedback.create({ data: { companyId: args.companyId, productId: scope === "product" ? args.productId! : null, itemKey: args.itemKey ?? null, buildId: args.buildId ?? null, userId: args.userId, text, kind: c.kind, scope, actions: JSON.stringify(c.actions) } });
  // Rework on a specific run is part of its outcome (user acceptance is a measured signal).
  if (args.buildId && c.actions.some((a) => a.type === "rework")) await prisma.runOutcome.updateMany({ where: { companyId: args.companyId, buildId: args.buildId }, data: { reworkRequested: true } });
  await audit(args.companyId, args.actor, "FEEDBACK_RECORDED", fb.id, `${c.kind} (${scope}): ${c.actions.map((a) => a.type).join(", ")}`);
  return { ...fb, actions: c.actions };
}

/** Active feedback relevant to a task: this product's + workspace-wide, never another workspace's. */
export async function feedbackFor(companyId: string, productId: string) {
  const rows = await prisma.userFeedback.findMany({ where: { companyId, status: "ACTIVE", OR: [{ productId }, { scope: "workspace" }] }, orderBy: { createdAt: "desc" }, take: 10 });
  return rows.map((r) => ({ ...r, actions: JSON.parse(r.actions) as FeedbackAction[] }));
}

export async function markApplied(ids: string[]) {
  if (ids.length) await prisma.userFeedback.updateMany({ where: { id: { in: ids } }, data: { appliedCount: { increment: 1 }, lastAppliedAt: new Date() } });
}

export async function updateFeedback(companyId: string, id: string, actor: string, patch: { status?: "ACTIVE" | "DISABLED"; scope?: "product" | "workspace" }) {
  const f = await prisma.userFeedback.findFirst({ where: { id, companyId } });
  if (!f) throw new ApiError("Feedback not found", 404);
  if (patch.scope === "product" && !f.productId) throw new ApiError("This feedback is not tied to a product", 422);
  const row = await prisma.userFeedback.update({ where: { id: f.id }, data: patch });
  await audit(companyId, actor, "FEEDBACK_UPDATED", id, JSON.stringify(patch));
  return row;
}

export async function deleteFeedback(companyId: string, id: string, actor: string) {
  const r = await prisma.userFeedback.deleteMany({ where: { id, companyId } });
  if (!r.count) throw new ApiError("Feedback not found", 404);
  await audit(companyId, actor, "FEEDBACK_DELETED", id, "removed by user");
  return { deleted: true };
}
