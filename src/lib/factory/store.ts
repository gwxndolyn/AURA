/**
 * Product factory persistence: products, brief revisions, backlog items,
 * artifacts, approvals and lifecycle transitions. Everything is scoped by
 * companyId (nested ids via findFirst({ id, companyId })).
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { parseJSON } from "@/lib/utils";
import { audit, emitEvent } from "@/lib/events/emit";
import { AGENT_DEFS } from "@/lib/agents/definitions";
import { permissionsFor } from "@/lib/agents/permissions";
import { REPOS } from "@/lib/missions/repos";
import { seedProjectFromFixture } from "@/lib/devspace/changes";
import { canMovePhase, assertItemMove, LifecycleError, PHASE_LABEL, type Actor, type ItemStatus, type Phase } from "./lifecycle";
import { draftBrief, draftBacklog, BriefSchema, KIND_AGENTS, KIND_VERIFY, changedRequirements, type BacklogDraft } from "./brief";
import { remember, markStale } from "./memory";
import { cancelBuild } from "@/lib/builder/service";
import { stackFor } from "@/lib/builder/stacks";
import { enqueue } from "@/lib/jobs/queue";
import { assertCanStart, recordUsage } from "@/lib/billing/entitlements";
import { clampLimits, needsApproval, type ActionClass, type Autonomy, AUTONOMY_LEVELS, type Limits } from "./policy";
import { initRepo } from "./git";

export type Evidence = { kind: string; ref: string; detail: string };
type HistoryEntry = { at: string; actor: string; change: string };

export const hashPayload = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export async function loadProduct(companyId: string, productId: string) {
  const p = await prisma.product.findFirst({ where: { id: productId, companyId } });
  if (!p) throw new ApiError("Product not found", 404);
  return p;
}
export type ProductRow = Awaited<ReturnType<typeof loadProduct>>;

export function limitsOf(p: { limits: string }): Limits {
  return clampLimits(parseJSON<Partial<Limits>>(p.limits, {}));
}

export async function productEvent(companyId: string, productId: string, message: string, opts: { actor?: string; level?: "info" | "success" | "warning" | "danger"; meta?: Record<string, unknown> } = {}) {
  await emitEvent({ companyId, type: "PRODUCT_UPDATED", actor: opts.actor, level: opts.level ?? "info", message, meta: { productId, ...opts.meta }, ops: { severity: opts.level === "danger" ? "high" : opts.level === "warning" ? "medium" : "info", source: "missions", resourceType: "product", resourceId: productId } });
}

/** Record a phase change (validated). No-op when unchanged. */
export async function movePhase(p: ProductRow, to: Phase, actor: string, reason: string, evidence: Evidence[] = []) {
  if (p.phase === to) return p;
  if (!canMovePhase(p.phase, to)) throw new LifecycleError(`Cannot move from ${p.phase} to ${to}`);
  const res = await prisma.product.updateMany({ where: { id: p.id, phase: p.phase }, data: { phase: to } });
  if (res.count !== 1) return (await prisma.product.findUnique({ where: { id: p.id } }))!; // a concurrent tick moved it
  await prisma.lifecycleTransition.create({ data: { productId: p.id, companyId: p.companyId, fromPhase: p.phase, toPhase: to, reason: reason.slice(0, 500), actor, evidence: JSON.stringify(evidence.slice(0, 10)) } });
  await productEvent(p.companyId, p.id, `${p.title}: ${PHASE_LABEL[p.phase as Phase] ?? p.phase} → ${PHASE_LABEL[to]} — ${reason}`, { actor: actor.includes("@") ? undefined : actor });
  return { ...p, phase: to };
}

export async function setItemStatus(item: { id: string; status: string; executable: boolean; level: string; history: string }, to: ItemStatus, actor: Actor, change: string, data: Record<string, unknown> = {}, opts: { verified?: boolean } = {}) {
  assertItemMove(item, to, actor, opts);
  const history = JSON.stringify([...parseJSON<HistoryEntry[]>(item.history, []), { at: new Date().toISOString(), actor: actor.id, change: `${item.status} → ${to}: ${change}`.slice(0, 400) }].slice(-60));
  // Compare-and-set on status so concurrent ticks cannot both move the item.
  const r = await prisma.backlogItem.updateMany({ where: { id: item.id, status: item.status }, data: { status: to, history, ...data } });
  return r.count === 1;
}

export async function appendItemHistory(itemId: string, actor: string, change: string, data: Record<string, unknown> = {}) {
  const item = await prisma.backlogItem.findUnique({ where: { id: itemId } });
  if (!item) return;
  const history = JSON.stringify([...parseJSON<HistoryEntry[]>(item.history, []), { at: new Date().toISOString(), actor, change: change.slice(0, 400) }].slice(-60));
  await prisma.backlogItem.update({ where: { id: itemId }, data: { history, ...data } });
}

/** Ensure agents introduced after a workspace was created (e.g. designer) exist. */
export async function ensureAgents(companyId: string) {
  const have = new Set((await prisma.agent.findMany({ where: { companyId }, select: { key: true } })).map((a) => a.key));
  const missing = AGENT_DEFS.filter((d) => !have.has(d.key));
  if (missing.length) await prisma.agent.createMany({ data: missing.map((d) => ({ companyId, key: d.key, name: d.name, role: d.role, avatar: d.avatar, color: d.color, personality: d.personality, status: "IDLE", permissions: JSON.stringify(permissionsFor(d.key)) })) });
}

/** Pick an executable fixture app for an idea, only when its code genuinely matches. */
export function templateForIdea(idea: string): string | null {
  return /team ?mates?|matching|match (students|people|users)/i.test(idea) ? "teammate-match" : null;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export async function requestApproval(p: ProductRow, args: { action: string; actionClass: ActionClass; target: string; summary: string; risks?: string[]; evidence?: Evidence[]; payload: unknown }) {
  const payloadHash = hashPayload(args.payload);
  const dup = await prisma.productApproval.findFirst({ where: { productId: p.id, action: args.action, target: args.target, status: "PENDING" } });
  if (dup) return dup;
  const a = await prisma.productApproval.create({ data: { productId: p.id, companyId: p.companyId, action: args.action, actionClass: args.actionClass, target: args.target, summary: args.summary.slice(0, 800), risks: JSON.stringify(args.risks ?? []), evidence: JSON.stringify(args.evidence ?? []), payloadHash } });
  await prisma.notification.upsert({
    where: { companyId_dedupeKey: { companyId: p.companyId, dedupeKey: `product-approval:${a.id}` } },
    create: { companyId: p.companyId, dedupeKey: `product-approval:${a.id}`, kind: "approval", severity: args.actionClass === "production" ? "high" : "medium", title: `Approval needed: ${args.summary.slice(0, 120)}`, body: `${p.title} · ${args.target}`, href: `/products/${p.id}?tab=approvals` },
    update: {},
  });
  await productEvent(p.companyId, p.id, `Approval requested: ${args.summary}`, { level: "warning", meta: { approvalId: a.id } });
  return a;
}

export async function loadPendingApproval(companyId: string, productId: string, approvalId: string) {
  const a = await prisma.productApproval.findFirst({ where: { id: approvalId, companyId, productId } });
  if (!a) throw new ApiError("Approval not found", 404);
  if (a.status !== "PENDING") throw new ApiError(`Approval already ${a.status.toLowerCase()}`, 409);
  return a;
}

export async function closeApproval(a: { id: string; companyId: string }, status: "APPROVED" | "REJECTED" | "CANCELLED", actor: string, note = "") {
  const r = await prisma.productApproval.updateMany({ where: { id: a.id, status: "PENDING" }, data: { status, decidedBy: actor, decidedAt: new Date(), note: note.slice(0, 500) } });
  if (r.count !== 1) throw new ApiError("Approval was decided concurrently", 409);
  await prisma.notification.deleteMany({ where: { companyId: a.companyId, dedupeKey: `product-approval:${a.id}` } });
}

// ---------------------------------------------------------------------------
// Create product: brief + backlog + repository + scope approval request
// ---------------------------------------------------------------------------

export async function createProduct(args: { companyId: string; userId: string; actor: string; idea: string; autonomy?: Autonomy; limits?: Partial<Limits>; stack?: string }) {
  const idea = args.idea.trim();
  if (idea.length < 20) throw new ApiError("Describe the product in at least 20 characters", 422);
  if (args.autonomy && !AUTONOMY_LEVELS.includes(args.autonomy)) throw new ApiError("Unknown autonomy level", 422);
  await assertCanStart(args.companyId, "product");
  await ensureAgents(args.companyId);
  const recent = await prisma.product.count({ where: { companyId: args.companyId, createdAt: { gte: new Date(Date.now() - 3600_000) } } });
  if (recent >= 20) throw new ApiError("Product creation is limited to 20 per hour per workspace", 429);
  const stack = stackFor(args.stack);
  const product = await prisma.product.create({
    data: { companyId: args.companyId, title: idea.split(/[.\n]/)[0].slice(0, 80), idea: idea.slice(0, 4000), autonomy: args.autonomy ?? "SUPERVISED", limits: JSON.stringify(clampLimits(args.limits ?? {})), stack: stack.id, createdById: args.userId, planningStatus: "QUEUED", phase: "DISCOVERY" },
  });
  // A real git repository for the product, initialised with the stack's runnable starting point.
  const repo = await prisma.repoConnection.create({ data: { companyId: args.companyId, provider: "local", name: `product-${product.id}`, defaultBranch: "main" } });
  const init = await initRepo(args.companyId, repo.id, "main", stack.files);
  await prisma.gitOperation.create({ data: { repoId: repo.id, companyId: args.companyId, productId: product.id, op: "init", branch: "main", sha: init.sha, status: "SUCCEEDED", detail: `initialised from the ${stack.label} starter` } });
  const withRepo = await prisma.product.update({ where: { id: product.id }, data: { repoId: repo.id } });
  await audit(args.companyId, args.actor, "PRODUCT_CREATED", product.id, product.title);
  await recordUsage(args.companyId, [{ metric: "product", quantity: 1 }], `product:${product.id}`);
  const job = await enqueue({ companyId: args.companyId, type: "product.plan", payload: { productId: product.id }, dedupeKey: `plan:${product.id}:1`, maxAttempts: 3, createdBy: args.actor });
  await productEvent(args.companyId, product.id, `Product created: the product manager is drafting the brief and backlog`, { actor: "product-manager", meta: { jobId: job.id } });
  return { product: withRepo, jobId: job.id };
}

/** Planning job body: PM brief → backlog (model, validated) → scope approval. Idempotent. */
export async function planProduct(companyId: string, productId: string) {
  const p = await loadProduct(companyId, productId);
  if (p.planningStatus === "READY" && (await prisma.productBrief.count({ where: { productId } }))) return { status: "already planned" };
  await prisma.product.update({ where: { id: p.id }, data: { planningStatus: "RUNNING", planningError: "" } });
  const stack = stackFor(p.stack);
  const brief = await draftBrief(p.idea);
  const backlog = await draftBacklog(brief.value, stack.conventions);
  const existing = await prisma.productBrief.findFirst({ where: { productId }, orderBy: { version: "desc" } });
  const b = existing ?? (await prisma.productBrief.create({ data: { productId, companyId, version: 1, content: JSON.stringify(brief.value), source: "model", author: "product-manager", note: `${brief.model}; ${brief.attempts} attempt(s)` } }));
  await insertBacklog(p, backlog.value, "product-manager");
  // Brief assumptions enter project memory as labelled ASSUMPTIONS (never as facts).
  for (const a of brief.value.assumptions) await remember({ companyId, productId, key: `assumption:${a.id}`, kind: "decision", content: a.text, status: "ASSUMPTION", provenance: { type: "brief", ref: b.id, detail: `brief v${b.version} ${a.id}` } });
  const cost = brief.costUsd + backlog.costUsd;
  await recordUsage(companyId, [{ metric: "ai_cost_usd", quantity: cost }, { metric: "ai_tokens_in", quantity: brief.tokensIn + backlog.tokensIn }, { metric: "ai_tokens_out", quantity: brief.tokensOut + backlog.tokensOut }], `product:${productId}:planning`);
  const withTitle = await prisma.product.update({ where: { id: p.id }, data: { title: brief.value.title, planningStatus: "READY" } });
  const moved = await movePhase(withTitle, "PLANNING", "product-manager", `Brief v1 and initial backlog drafted by ${brief.model}`, [{ kind: "brief", ref: b.id, detail: "v1" }]);
  await requestApproval(moved, { action: "scope", actionClass: "analysis", target: "brief v1", summary: `Approve the MVP scope for ${brief.value.title} before agents start building`, risks: brief.value.questions.filter((q) => q.material).map((q) => `Open question: ${q.text} (default: ${q.default})`), evidence: [{ kind: "brief", ref: b.id, detail: "v1" }], payload: { brief: 1 } });
  return { status: "planned", costUsd: cost };
}

/** Record model usage of a planning call (estimate from provider-reported tokens). */
export async function recordUsageFor(companyId: string, source: string, u: { costUsd: number; tokensIn: number; tokensOut: number } | null) {
  if (!u) return;
  await recordUsage(companyId, [{ metric: "ai_cost_usd", quantity: u.costUsd }, { metric: "ai_tokens_in", quantity: u.tokensIn }, { metric: "ai_tokens_out", quantity: u.tokensOut }], source);
}

/** Insert backlog items from a validated draft. Existing keys are kept (idempotent). */
async function insertBacklog(p: ProductRow, draft: BacklogDraft, actor: string) {
  const existing = new Set((await prisma.backlogItem.findMany({ where: { productId: p.id }, select: { key: true } })).map((i) => i.key));
  let priority = 10;
  const rows: Parameters<typeof prisma.backlogItem.create>[0]["data"][] = [];
  for (const e of draft.epics) {
    rows.push({ productId: p.id, companyId: p.companyId, key: e.key, level: "EPIC", title: e.title, priority: priority++ });
    for (const s of e.stories) {
      rows.push({ productId: p.id, companyId: p.companyId, key: s.key, level: "STORY", parentKey: e.key, title: s.title, acceptance: JSON.stringify(s.acceptance), milestone: s.milestone, priority: priority++ });
      for (const t of s.tasks) {
        // Code and test tasks run in the product's own repository and are verified by executed commands.
        const executable = ["BACKEND", "FRONTEND", "DATA", "TEST"].includes(t.kind);
        rows.push({
          productId: p.id, companyId: p.companyId, key: t.key, level: "TASK", kind: t.kind, parentKey: s.key, title: t.title, description: t.description,
          acceptance: JSON.stringify(t.acceptance), dependsOn: JSON.stringify(t.dependsOn), effort: t.effort, risk: t.risk, files: JSON.stringify(t.files), requirements: JSON.stringify(t.requirements ?? []),
          capabilities: JSON.stringify(KIND_AGENTS[t.kind] ?? []), verifyBy: JSON.stringify(KIND_VERIFY[t.kind] ?? []),
          executable, milestone: s.milestone, priority: priority++,
          history: JSON.stringify([{ at: new Date().toISOString(), actor, change: "created by the product manager" }]),
        });
      }
    }
  }
  for (const r of rows) if (!existing.has(r.key as string)) await prisma.backlogItem.create({ data: r });
}

/**
 * Edit the brief → new revision. Changed requirements invalidate downstream
 * work that implements them (traceability via BacklogItem.requirements):
 *   - VERIFIED / accepted items → reopened (READY) with the reason
 *   - in-flight runs → cancelled (their result would answer the old requirement)
 *   - queued items stay queued; project memory about those requirements → STALE
 * Items without requirement links fall back to being flagged for review.
 * The change is recorded as a versioned CHANGE_SET artifact.
 */
export async function reviseBrief(companyId: string, productId: string, actor: string, content: unknown, expectedVersion: number, note = "") {
  const p = await loadProduct(companyId, productId);
  const parsed = BriefSchema.safeParse(content);
  if (!parsed.success) throw new ApiError(`Brief failed validation: ${parsed.error.errors.slice(0, 4).map((e) => `${e.path.join(".")} ${e.message}`).join("; ")}`, 422);
  const latest = await prisma.productBrief.findFirst({ where: { productId }, orderBy: { version: "desc" } });
  if (!latest || latest.version !== expectedVersion) throw new ApiError(`The brief changed since you loaded it (v${expectedVersion} → v${latest?.version}); reload and retry`, 409);
  const prev = BriefSchema.parse(JSON.parse(latest.content));
  const b = await prisma.productBrief.create({ data: { productId, companyId, version: latest.version + 1, content: JSON.stringify(parsed.data), source: "user", author: actor, note: note.slice(0, 500) } });
  const diff = changedRequirements(prev, parsed.data);
  const touchedReqs = [...diff.changed, ...diff.removed];
  const affected: string[] = [], reopened: string[] = [], cancelled: string[] = [], flagged: string[] = [];
  if (diff.any) {
    const items = await prisma.backlogItem.findMany({ where: { productId, level: { in: ["TASK", "REPAIR", "STORY"] }, status: { not: "CANCELLED" } } });
    const linked = items.filter((i) => parseJSON<string[]>(i.requirements, []).some((r) => touchedReqs.includes(r)));
    const anyLinks = items.some((i) => parseJSON<string[]>(i.requirements, []).length);
    for (const i of linked) {
      affected.push(i.key);
      const why = `requirement ${parseJSON<string[]>(i.requirements, []).filter((r) => touchedReqs.includes(r)).join(", ")} changed in brief v${b.version}`;
      if (i.status === "IN_PROGRESS" && i.buildId) {
        await cancelBuild(companyId, i.buildId).catch(() => null);
        await setItemStatus(i, "BLOCKED", { kind: "engine", id: "requirements" }, `${why}; the in-flight run was cancelled`, { verification: "NOT_RUN", blockedReason: `${why}. Re-approve the scope to rebuild it against the new requirement.` });
        cancelled.push(i.key);
      } else if (["VERIFIED", "DONE_UNVERIFIED", "IN_REVIEW", "FAILED", "BLOCKED"].includes(i.status)) {
        const target = i.status === "IN_REVIEW" ? "IN_PROGRESS" : "READY";
        if (target === "IN_PROGRESS") await setItemStatus(i, "BLOCKED", { kind: "engine", id: "requirements" }, why, { verification: "NOT_RUN", blockedReason: why });
        else await setItemStatus(i, "READY", { kind: "engine", id: "requirements" }, `${why}; previous verification no longer applies`, { verification: "NOT_RUN", buildId: null, attempts: 0, blockedReason: "" });
        reopened.push(i.key);
      } else await appendItemHistory(i.id, actor, why);
    }
    if (!anyLinks) for (const i of items) { await appendItemHistory(i.id, actor, `requirements changed in brief v${b.version}; review whether this item is still correct`); flagged.push(i.key); }
    await markStale(companyId, productId, { requirements: touchedReqs, reason: `requirements ${touchedReqs.join(", ")} changed in brief v${b.version}` });
  }
  // New requirements invalidate nothing, but no task implements them yet: they need planning (and the gate shows them as untraced).
  const unplanned = diff.added.filter((r) => !r.startsWith("NFR-"));
  const changeSet = { kind: "requirements", briefFrom: latest.version, briefTo: b.version, requirements: diff, affected, reopened, cancelled, flagged, unplanned, actor, note };
  const csVersion = ((await prisma.productArtifact.findFirst({ where: { productId, kind: "CHANGE_SET" }, orderBy: { version: "desc" } }))?.version ?? 0) + 1;
  await prisma.productArtifact.create({ data: { productId, companyId, kind: "CHANGE_SET", version: csVersion, title: `Change set ${csVersion}: brief v${latest.version} → v${b.version}`, content: JSON.stringify(changeSet), status: "APPROVED", source: "user", producedBy: actor } });
  await audit(companyId, actor, "PRODUCT_BRIEF_REVISED", productId, `v${b.version}${affected.length ? `; ${affected.length} items affected` : ""}`);
  await productEvent(companyId, productId, `Brief revised to v${b.version} by ${actor}${diff.any ? ` — requirements changed (${[...diff.changed, ...diff.added, ...diff.removed].join(", ")}); ${reopened.length} item(s) reopened, ${cancelled.length} run(s) cancelled` : ""}`);
  if (p.scopeApproved && diff.any) {
    await prisma.product.update({ where: { id: productId }, data: { scopeApproved: false } });
    const fresh = await loadProduct(companyId, productId);
    await requestApproval(fresh, { action: "scope", actionClass: "analysis", target: `brief v${b.version}`, summary: `Re-approve scope: requirements changed in brief v${b.version}`, evidence: [{ kind: "brief", ref: b.id, detail: `v${b.version}` }], payload: { brief: b.version } });
  }
  return { version: b.version, affected: affected.length ? affected : flagged, reopened, cancelled, unplanned, requirements: diff, changeSet: csVersion };
}

export async function addItem(companyId: string, productId: string, actor: string, input: { parentKey: string; title: string; description: string; kind: string; acceptance: string[]; dependsOn: string[]; files: string[]; risk: "LOW" | "MEDIUM" | "HIGH" }) {
  const p = await loadProduct(companyId, productId);
  const parent = await prisma.backlogItem.findFirst({ where: { productId, companyId, key: input.parentKey, level: "STORY" } });
  if (!parent) throw new ApiError("Parent story not found", 404);
  const siblings = await prisma.backlogItem.count({ where: { productId, parentKey: parent.key, level: "TASK" } });
  const key = `${parent.key}.T${siblings + 1}`;
  const all = await prisma.backlogItem.findMany({ where: { productId }, select: { key: true } });
  const unknown = input.dependsOn.filter((d) => !all.some((a) => a.key === d));
  if (unknown.length) throw new ApiError(`Unknown dependencies: ${unknown.join(", ")}`, 422);
  void p;
  const executable = ["BACKEND", "FRONTEND", "DATA", "TEST"].includes(input.kind);
  const item = await prisma.backlogItem.create({ data: { productId, companyId, key, level: "TASK", kind: input.kind, parentKey: parent.key, title: input.title, description: input.description, acceptance: JSON.stringify(input.acceptance), dependsOn: JSON.stringify(input.dependsOn), files: JSON.stringify(input.files), risk: input.risk, capabilities: JSON.stringify(KIND_AGENTS[input.kind] ?? []), verifyBy: JSON.stringify(KIND_VERIFY[input.kind] ?? []), executable, milestone: parent.milestone, history: JSON.stringify([{ at: new Date().toISOString(), actor, change: "created by a person" }]) } });
  await audit(companyId, actor, "BACKLOG_ITEM_ADDED", productId, key);
  return item;
}

/** Person-initiated status changes (cancel / reopen / accept non-executable work unverified). */
export async function userSetItemStatus(companyId: string, productId: string, key: string, actor: string, to: ItemStatus, note = "") {
  const item = await prisma.backlogItem.findFirst({ where: { productId, companyId, key } });
  if (!item) throw new ApiError("Item not found", 404);
  if (to === "IN_PROGRESS" || to === "IN_REVIEW") throw new ApiError("Start work with Dispatch; execution sets this status", 422);
  const ok = await setItemStatus(item, to, { kind: "user", id: actor }, note || `set by ${actor}`);
  if (!ok) throw new ApiError("Item changed concurrently; reload", 409);
  await audit(companyId, actor, "BACKLOG_ITEM_STATUS", `${productId}:${key}`, `${item.status} → ${to}`);
  return { key, status: to };
}

export async function setPriority(companyId: string, productId: string, key: string, actor: string, priority: number) {
  const item = await prisma.backlogItem.findFirst({ where: { productId, companyId, key } });
  if (!item) throw new ApiError("Item not found", 404);
  await appendItemHistory(item.id, actor, `priority ${item.priority} → ${priority}`, { priority: Math.max(0, Math.min(10_000, Math.round(priority))) });
  return { key, priority };
}

export async function updateSettings(companyId: string, productId: string, actor: string, input: { autonomy?: Autonomy; limits?: Partial<Limits> }, expectedVersion: number) {
  const p = await loadProduct(companyId, productId);
  if (p.version !== expectedVersion) throw new ApiError("Settings changed since you loaded them; reload and retry", 409);
  if (input.autonomy && !AUTONOMY_LEVELS.includes(input.autonomy)) throw new ApiError("Unknown autonomy level", 422);
  const limits = input.limits ? clampLimits({ ...limitsOf(p), ...input.limits }) : limitsOf(p);
  const r = await prisma.product.updateMany({ where: { id: p.id, version: p.version }, data: { autonomy: input.autonomy ?? p.autonomy, limits: JSON.stringify(limits), version: p.version + 1 } });
  if (r.count !== 1) throw new ApiError("Settings changed concurrently; reload and retry", 409);
  await audit(companyId, actor, "PRODUCT_SETTINGS", productId, `autonomy ${input.autonomy ?? p.autonomy}; limits ${JSON.stringify(limits)}`);
  return loadProduct(companyId, productId);
}

export { needsApproval };
