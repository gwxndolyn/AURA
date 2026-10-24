/**
 * Product evolution & continuous maintenance (AURA V14).
 *
 * Reuses: product lifecycle + backlog (factory/store), change requests
 * (factory/change), the dependency graph + integration findings (V13), debt
 * analysis, learning attributions/feedback (V11), release readiness/gate,
 * deployment records, and the durable job queue.
 *
 *   versionState()      latest workspace sha · last VERIFIED (release
 *                       candidate) · DEPLOYED (only from a VERIFIED deployment
 *                       record) · proposed (open items/proposals) · rolled back
 *   collectProposals()  evidence → ImprovementProposal rows, deduplicated by
 *                       fingerprint; obsolete ones closed; mandatory security /
 *                       data-integrity items flagged
 *   prioritize()        transparent qualitative scoring with the reasons stored;
 *                       mandatory items always rank above optional ones
 *   runCycle()          one bounded maintenance cycle under the product's mode:
 *                         OBSERVE              analyse only (no proposals executed, no code)
 *                         RECOMMEND            proposals + plans; nothing executes
 *                         IMPLEMENT_ISOLATED   APPROVED proposals → backlog tasks on
 *                                              isolated branches; no release
 *                         AUTONOMOUS           + low-risk policy-eligible proposals
 *                       budgets: changes per cycle, attempts per issue,
 *                       concurrent cycles, unreviewed changes, wall time;
 *                       checkpoints persisted per step (resumable)
 *   decide()            approve / reject / reprioritise (ADMIN for sensitive)
 *
 * Approval is ALWAYS required (whatever the mode) for: authentication /
 * authorization, secrets / sensitive data, destructive migrations, major
 * architecture changes, production deployment, insufficient verification.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { parseJSON } from "@/lib/utils";
import { audit } from "@/lib/events/emit";
import { log } from "@/lib/observability/log";
import { loadProduct, productEvent, assertNotArchived } from "./store";
import { headSha, listFiles, readAt } from "./git";
import { integrationBase } from "./base";
import { indexSnapshot } from "@/lib/builder/intel";
import { snapshotGraph } from "@/lib/builder/integration";
import { analyzeDebt, dependencyReview } from "./debt";
import { assessRisk } from "@/lib/builder/orchestrator";
import { emit as emitLearning } from "@/lib/learning/service";

export const MAINTENANCE_MODES = ["OBSERVE", "RECOMMEND", "IMPLEMENT_ISOLATED", "AUTONOMOUS"] as const;
export type MaintenanceMode = (typeof MAINTENANCE_MODES)[number];
export interface MaintenanceBudget { maxConcurrent: number; maxAttemptsPerIssue: number; maxChangesPerCycle: number; maxCycleMs: number; maxUnreviewed: number }
export const DEFAULT_BUDGET: MaintenanceBudget = { maxConcurrent: 1, maxAttemptsPerIssue: 2, maxChangesPerCycle: 2, maxCycleMs: 10 * 60_000, maxUnreviewed: 3 };
export function budgetOf(p: { maintenanceBudget: string }): MaintenanceBudget {
  const b = { ...DEFAULT_BUDGET, ...parseJSON<Partial<MaintenanceBudget>>(p.maintenanceBudget, {}) };
  return { maxConcurrent: Math.min(Math.max(b.maxConcurrent, 1), 3), maxAttemptsPerIssue: Math.min(Math.max(b.maxAttemptsPerIssue, 1), 5), maxChangesPerCycle: Math.min(Math.max(b.maxChangesPerCycle, 0), 10), maxCycleMs: Math.min(Math.max(b.maxCycleMs, 10_000), 3_600_000), maxUnreviewed: Math.min(Math.max(b.maxUnreviewed, 0), 20) };
}

// ---------------------------------------------------------------------------
// Version-aware state
// ---------------------------------------------------------------------------

export async function versionState(companyId: string, productId: string) {
  const p = await loadProduct(companyId, productId);
  const repo = p.repoId ? await prisma.repoConnection.findFirst({ where: { id: p.repoId, companyId } }) : null;
  const latest = repo ? { branch: repo.defaultBranch, sha: await headSha(companyId, repo.id, repo.defaultBranch) } : null;
  const rcs = await prisma.productArtifact.findMany({ where: { productId, companyId, kind: "RELEASE_CANDIDATE" }, orderBy: { version: "desc" }, take: 10 });
  const verified = rcs.find((r) => r.status === "APPROVED" && parseJSON<{ test?: { failed: number; total: number } }>(r.content, {}).test?.failed === 0);
  const deploys = await prisma.productDeployment.findMany({ where: { productId, companyId }, orderBy: { createdAt: "desc" }, take: 20 });
  const live = deploys.filter((d) => d.status === "VERIFIED");
  const rolledBack = deploys.filter((d) => d.status === "ROLLED_BACK").map((d) => ({ sha: d.sha, env: d.env, at: d.finishedAt, restored: d.rolledBackTo }));
  const open = await prisma.backlogItem.count({ where: { productId, companyId, level: { in: ["TASK", "REPAIR"] }, status: { notIn: ["VERIFIED", "DONE_UNVERIFIED", "CANCELLED"] } } });
  const proposals = await prisma.improvementProposal.count({ where: { productId, companyId, status: { in: ["OPEN", "APPROVED", "IN_PROGRESS"] } } });
  const capabilities = await prisma.backlogItem.findMany({ where: { productId, companyId, level: "STORY", status: "VERIFIED" }, select: { key: true, title: true } });
  return {
    phase: p.phase, status: p.status, maintenanceMode: p.maintenanceMode,
    latest, // workspace code (may include unverified changes)
    verified: verified ? { version: verified.version, ...parseJSON<{ branch?: string; sha?: string }>(verified.content, {}) } : null,
    deployed: live.map((d) => ({ env: d.env, sha: d.sha, url: d.url, at: d.finishedAt })), // only VERIFIED deployment records count
    rolledBack, openItems: open, openProposals: proposals, capabilities,
    note: live.length ? null : "No verified deployment record: AURA does not assume any version is deployed.",
  };
}

// ---------------------------------------------------------------------------
// Proposals from evidence
// ---------------------------------------------------------------------------

type Draft = { fingerprint: string; source: string; title: string; problem: string; evidence: { kind: string; ref: string; detail: string }[]; impact: string; components: string[]; requirements: string[]; benefit: string; effort: string; uncertainty: string; risk: string; mandatory: boolean; verification: string[] };

async function latestFiles(companyId: string, productId: string) {
  const p = await loadProduct(companyId, productId);
  const repo = p.repoId ? await prisma.repoConnection.findFirst({ where: { id: p.repoId, companyId } }) : null;
  if (!repo) return null;
  const base = await integrationBase(companyId, productId, repo);
  const sha = await headSha(companyId, repo.id, base.branch);
  if (!sha) return null;
  const files: Record<string, string> = {};
  for (const f of await listFiles(companyId, repo.id, base.branch)) {
    if (f.split("/").some((s) => s === "node_modules" || s === ".git") || /(^|\/)\.env$/.test(f) || !/\.(c|m)?(j|t)sx?$|\.(json|html?|css|md|prisma|sql)$|\.env\.example$/.test(f)) continue;
    const c = await readAt(companyId, repo.id, base.branch, f);
    if (c !== null && c.length < 200_000) files[f] = c;
  }
  return { repo, sha, branch: base.branch, files };
}

export async function collectProposals(companyId: string, productId: string) {
  const src = await latestFiles(companyId, productId);
  const drafts: Draft[] = [];
  const missing: string[] = [];
  if (src) {
    const index = await indexSnapshot(companyId, src.repo.id, src.sha, src.files);
    const { graph, findings } = await snapshotGraph({ companyId, productId, sha: src.sha, index, files: src.files });
    for (const d of analyzeDebt(index, src.files, graph).filter((x) => x.objective || x.severity !== "low")) drafts.push({ fingerprint: `debt:${d.id}`, source: "debt", title: d.title, problem: d.consequence, evidence: d.evidence.map((e) => ({ kind: "code", ref: `${e.file}${e.line ? `:${e.line}` : ""}`, detail: e.detail })), impact: d.consequence, components: d.files, requirements: [], benefit: d.severity === "high" ? "high — prevents user-facing failures" : d.severity === "medium" ? "medium — lowers regression risk of future changes" : "low — maintenance cost", effort: d.files.length > 3 ? "large" : d.kind === "missing_tests" || d.kind === "duplicated_logic" ? "small" : "medium", uncertainty: d.objective ? "low" : "medium", risk: d.kind === "complexity" ? "medium" : "low", mandatory: /Internal error details/.test(d.title), verification: d.verification });
    for (const f of findings.filter((x) => x.confidence === "confirmed")) drafts.push({ fingerprint: `contract:${f.kind}:${f.files.join(",")}`, source: "defect", title: `Integration: ${f.detail}`.slice(0, 200), problem: f.detail, evidence: [{ kind: "graph", ref: src.sha.slice(0, 8), detail: f.detail }], impact: "the affected feature fails at runtime", components: f.files, requirements: [], benefit: "high — restores a broken user flow", effort: "small", uncertainty: "low", risk: "low", mandatory: false, verification: ["integration/browser journey passes"] });
    const dep = dependencyReview(src.files);
    for (const c of dep.checks.filter((x) => x.status === "warning" || x.status === "failed")) drafts.push({ fingerprint: `dep:${c.id}`, source: "dependency", title: `Dependencies: ${c.detail}`.slice(0, 200), problem: c.detail, evidence: [{ kind: "manifest", ref: "package.json", detail: c.detail }], impact: "reproducibility / compatibility", components: ["package.json"], requirements: [], benefit: "low — stability of installs", effort: "small", uncertainty: "low", risk: "low", mandatory: false, verification: ["install + full suite pass"] });
    for (const c of dep.checks.filter((x) => x.status === "not_run")) missing.push(c.detail);
  } else missing.push("no repository snapshot available");
  // Verified defects / failed tasks / security findings / feedback / unfinished requirements.
  const items = await prisma.backlogItem.findMany({ where: { productId, companyId, level: { in: ["TASK", "REPAIR"] }, status: { in: ["FAILED", "BLOCKED"] } } });
  for (const i of items) drafts.push({ fingerprint: `task:${i.key}`, source: "defect", title: `Unfinished: ${i.key} ${i.title}`.slice(0, 200), problem: i.blockedReason || `task ${i.status.toLowerCase()}`, evidence: [{ kind: "item", ref: i.key, detail: i.status }], impact: "requirement not delivered", components: parseJSON<string[]>(i.files, []), requirements: parseJSON<string[]>(i.requirements, []), benefit: "high — completes a planned requirement", effort: "medium", uncertainty: "medium", risk: i.risk === "HIGH" ? "high" : "medium", mandatory: false, verification: ["task acceptance criteria verified"] });
  const builds = await prisma.build.findMany({ where: { productId, companyId, status: "VERIFIED" }, select: { id: true, itemKey: true, findings: true } });
  for (const b of builds) for (const f of parseJSON<{ source: string; severity: string; title: string; blocking: boolean; evidence: string }[]>(b.findings, []).filter((x) => x.source === "security" && !x.blocking && ["medium", "high", "critical"].includes(x.severity))) drafts.push({ fingerprint: `sec:${b.itemKey}:${f.title}`, source: "security", title: `Security: ${f.title}`.slice(0, 200), problem: f.title, evidence: [{ kind: "finding", ref: b.id, detail: f.evidence.slice(0, 200) }], impact: "security exposure", components: [], requirements: [], benefit: "high — removes a security risk", effort: "small", uncertainty: "medium", risk: "medium", mandatory: true, verification: ["test proving the control blocks the bad case"] });
  const fb = await prisma.userFeedback.findMany({ where: { companyId, productId, status: "ACTIVE" } });
  for (const f of fb) drafts.push({ fingerprint: `feedback:${f.id}`, source: "feedback", title: `User feedback: ${f.text}`.slice(0, 200), problem: f.text, evidence: [{ kind: "feedback", ref: f.id, detail: f.kind }], impact: "explicit user request", components: [], requirements: [], benefit: "high — requested by a user", effort: "medium", uncertainty: "medium", risk: "medium", mandatory: false, verification: parseJSON<{ detail: string }[]>(f.actions, []).map((a) => a.detail).slice(0, 3) });
  const attr = await prisma.failureAttribution.groupBy({ by: ["category"], where: { companyId, productId, status: "ESTABLISHED", scope: "agent" }, _count: { _all: true } });
  for (const a of attr.filter((x) => x._count._all >= 2)) drafts.push({ fingerprint: `lesson:${a.category}`, source: "lesson", title: `Recurring failure cause: ${a.category.replace(/_/g, " ")} (${a._count._all}×)`, problem: "AURA's own runs keep failing for this reason in this product", evidence: [{ kind: "attribution", ref: a.category, detail: `${a._count._all} established attributions` }], impact: "slower delivery, more retries", components: [], requirements: [], benefit: "medium — fewer failed runs", effort: "small", uncertainty: "medium", risk: "low", mandatory: false, verification: ["fewer attributions of this category in later runs"] });

  // Upsert (dedupe by fingerprint); close proposals whose evidence disappeared.
  const now = new Date();
  const seen = new Set<string>();
  for (const d of drafts) {
    if (seen.has(d.fingerprint)) continue;
    seen.add(d.fingerprint);
    const approval = d.mandatory || d.risk !== "low" || /auth|password|secret|token|migration|schema/i.test(`${d.title} ${d.components.join(" ")}`) ? "required" : "policy";
    const data = { source: d.source, title: d.title, problem: d.problem, evidence: JSON.stringify(d.evidence.slice(0, 10)), impact: d.impact, components: JSON.stringify(d.components), requirements: JSON.stringify(d.requirements), benefit: d.benefit, effort: d.effort, uncertainty: d.uncertainty, risk: d.risk, mandatory: d.mandatory, verification: JSON.stringify(d.verification), approval, lastSeenAt: now };
    const prev = await prisma.improvementProposal.findUnique({ where: { productId_fingerprint: { productId, fingerprint: d.fingerprint } } });
    if (!prev) await prisma.improvementProposal.create({ data: { companyId, productId, fingerprint: d.fingerprint, ...data } });
    else if (["OPEN", "APPROVED"].includes(prev.status)) await prisma.improvementProposal.update({ where: { id: prev.id }, data });
    else if (prev.status === "OBSOLETE") await prisma.improvementProposal.update({ where: { id: prev.id }, data: { ...data, status: "OPEN" } }); // evidence came back
    else if (prev.status === "DONE") await prisma.improvementProposal.update({ where: { id: prev.id }, data: { outcome: JSON.stringify({ ...parseJSON(prev.outcome, {}), objectiveMet: false, note: "the problem is still detected after the change" }) } });
  }
  const stale = await prisma.improvementProposal.updateMany({ where: { companyId, productId, status: "OPEN", fingerprint: { notIn: [...seen] }, source: { not: "user_request" } }, data: { status: "OBSOLETE" } });
  await prioritize(companyId, productId);
  return { proposals: seen.size, closedObsolete: stale.count, missingSources: [...missing, "product analytics: not connected (no user-behaviour data is inferred)", "production monitoring: not connected"] };
}

const W = { severity: { high: 3, medium: 2, low: 1 } as Record<string, number>, effort: { small: 1, medium: 0, large: -1 } as Record<string, number>, risk: { low: 1, medium: 0, high: -1 } as Record<string, number>, certainty: { low: 1, medium: 0, high: -1 } as Record<string, number> };

/** Transparent ranking: mandatory first, then benefit, certainty, effort and regression risk; the reasons are stored. */
export async function prioritize(companyId: string, productId: string) {
  const rows = await prisma.improvementProposal.findMany({ where: { companyId, productId, status: { in: ["OPEN", "APPROVED"] } } });
  for (const r of rows) {
    const benefit = r.benefit.split(" ")[0];
    const why = [
      r.mandatory ? "+100 mandatory (security / data integrity)" : "",
      `+${W.severity[benefit] ?? 1}0 benefit ${benefit}`,
      `${W.certainty[r.uncertainty] >= 0 ? "+" : ""}${(W.certainty[r.uncertainty] ?? 0) * 5} uncertainty ${r.uncertainty}`,
      `${W.effort[r.effort] >= 0 ? "+" : ""}${(W.effort[r.effort] ?? 0) * 5} effort ${r.effort}`,
      `${W.risk[r.risk] >= 0 ? "+" : ""}${(W.risk[r.risk] ?? 0) * 5} regression risk ${r.risk}`,
      r.source === "user_request" || r.source === "feedback" ? "+8 explicitly requested" : "",
    ].filter(Boolean);
    const score = (r.mandatory ? 100 : 0) + (W.severity[benefit] ?? 1) * 10 + (W.certainty[r.uncertainty] ?? 0) * 5 + (W.effort[r.effort] ?? 0) * 5 + (W.risk[r.risk] ?? 0) * 5 + (r.source === "user_request" || r.source === "feedback" ? 8 : 0);
    await prisma.improvementProposal.update({ where: { id: r.id }, data: { priority: score, priorityWhy: JSON.stringify(why) } });
  }
}

// ---------------------------------------------------------------------------
// Decisions and policy
// ---------------------------------------------------------------------------

/** Sensitive proposals always need an ADMIN decision; the caller passes the actor's role. */
export function requiresAdmin(p: { mandatory: boolean; title: string; components: string; approval: string }) {
  return p.approval === "required" && (p.mandatory || /auth|password|secret|token|migration|schema|deploy/i.test(`${p.title} ${p.components}`));
}

export async function decide(companyId: string, productId: string, id: string, actor: { email: string; role: string }, decision: "approve" | "reject" | "no_change" | "reprioritise", priority?: number) {
  const p = await prisma.improvementProposal.findFirst({ where: { id, companyId, productId } });
  if (!p) throw new ApiError("Proposal not found", 404);
  if (decision === "reprioritise") {
    if (p.mandatory && (priority ?? 0) < 100) throw new ApiError("Mandatory security/data-integrity proposals cannot be ranked below optional work", 422);
    const r = await prisma.improvementProposal.update({ where: { id }, data: { priority: priority ?? p.priority, priorityWhy: JSON.stringify([...parseJSON<string[]>(p.priorityWhy, []), `manually set to ${priority} by ${actor.email}`]) } });
    await audit(companyId, actor.email, "PROPOSAL_REPRIORITISED", id, String(priority));
    return r;
  }
  if (!["OPEN", "APPROVED"].includes(p.status)) throw new ApiError(`Proposal is ${p.status.toLowerCase()}`, 409);
  if (decision === "approve" && requiresAdmin(p) && !["ADMIN", "OWNER"].includes(actor.role)) throw new ApiError("This proposal touches security-sensitive areas; an admin must approve it", 403);
  const status = decision === "approve" ? "APPROVED" : decision === "reject" ? "REJECTED" : "NO_CHANGE_NEEDED";
  const r = await prisma.improvementProposal.update({ where: { id }, data: { status, decidedBy: actor.email } });
  await audit(companyId, actor.email, `PROPOSAL_${status}`, id, p.title.slice(0, 200));
  return r;
}

// ---------------------------------------------------------------------------
// Maintenance cycle (bounded, checkpointed)
// ---------------------------------------------------------------------------

/** Turn a proposal into ONE backlog task under a maintenance story (isolated branch via the normal builder). */
async function enqueueProposal(companyId: string, productId: string, prop: NonNullable<Awaited<ReturnType<typeof prisma.improvementProposal.findFirst>>>, actor: string) {
  const story = "M1";
  if (!(await prisma.backlogItem.findFirst({ where: { productId, key: story } }))) await prisma.backlogItem.create({ data: { productId, companyId, key: story, level: "STORY", title: "Maintenance and improvements", acceptance: JSON.stringify(["Each change is verified and preserves existing behaviour"]), milestone: "MAINTENANCE", history: JSON.stringify([{ at: new Date().toISOString(), actor, change: "maintenance story" }]) } });
  const n = await prisma.backlogItem.count({ where: { productId, parentKey: story } });
  const key = `${story}.T${n + 1}`;
  const files = parseJSON<string[]>(prop.components, []).filter((f) => !/^\.env/.test(f));
  const kind = files.some((f) => /^public\/|\.(html|css|jsx|tsx)$/.test(f)) ? "FRONTEND" : "BACKEND";
  const verification = parseJSON<string[]>(prop.verification, []);
  const risk = assessRisk({ risk: prop.risk.toUpperCase(), title: prop.title, description: prop.problem, acceptance: verification, files }).risk;
  await prisma.backlogItem.create({ data: { productId, companyId, key, level: "TASK", kind, parentKey: story, title: prop.title.slice(0, 160), description: `${prop.problem}\n\nEvidence: ${parseJSON<{ ref: string; detail: string }[]>(prop.evidence, []).map((e) => `${e.ref} ${e.detail}`).join("; ").slice(0, 600)}\n\nMake the smallest change. Preserve all existing behaviour and public contracts; existing tests must keep passing. If the code is already adequate, change nothing and say so.`.slice(0, 1800), acceptance: JSON.stringify([...verification, "All pre-existing tests still pass"].slice(0, 6)), files: JSON.stringify(files), risk, capabilities: JSON.stringify([kind === "FRONTEND" ? "frontend-engineer" : "backend-engineer"]), verifyBy: JSON.stringify(["sandbox tests", "code review"]), executable: true, milestone: "MAINTENANCE", status: "READY", priority: 50, requirements: prop.requirements, history: JSON.stringify([{ at: new Date().toISOString(), actor, change: `from proposal ${prop.id.slice(-6)}` }]) } });
  await prisma.improvementProposal.update({ where: { id: prop.id }, data: { status: "IN_PROGRESS", itemKey: key, attempts: { increment: 1 } } });
  return key;
}

export async function runCycle(companyId: string, productId: string, actor: string, opts: { cycleId?: string } = {}) {
  const p = await loadProduct(companyId, productId);
  assertNotArchived(p);
  const mode = (MAINTENANCE_MODES as readonly string[]).includes(p.maintenanceMode) ? (p.maintenanceMode as MaintenanceMode) : "RECOMMEND";
  const budget = budgetOf(p);
  const running = await prisma.maintenanceCycle.count({ where: { companyId, productId, status: "RUNNING", ...(opts.cycleId ? { id: { not: opts.cycleId } } : {}) } });
  if (running >= budget.maxConcurrent) throw new ApiError(`A maintenance cycle is already running for this product (limit ${budget.maxConcurrent})`, 409);
  const cycle = opts.cycleId ? await prisma.maintenanceCycle.findFirstOrThrow({ where: { id: opts.cycleId, companyId } }) : await prisma.maintenanceCycle.create({ data: { companyId, productId, mode, createdBy: actor, budget: JSON.stringify(budget) } });
  const cp = parseJSON<{ step?: string; executed?: string[]; skipped?: { id: string; why: string }[]; collected?: boolean }>(cycle.checkpoint, {});
  const save = (x: typeof cp) => prisma.maintenanceCycle.update({ where: { id: cycle.id }, data: { checkpoint: JSON.stringify(x) } });
  const started = Date.now();
  try {
    if (!cp.collected) {
      const c = await collectProposals(companyId, productId);
      Object.assign(cp, { step: "collected", collected: true, collectedSummary: c });
      await save(cp);
    }
    const executed = cp.executed ?? [];
    const skipped = cp.skipped ?? [];
    if (mode === "OBSERVE" || mode === "RECOMMEND") {
      const summary = `${mode.toLowerCase()} mode: proposals updated; nothing executed (policy)`;
      await prisma.maintenanceCycle.update({ where: { id: cycle.id }, data: { status: "COMPLETED", summary, finishedAt: new Date(), checkpoint: JSON.stringify({ ...cp, step: "done" }) } });
      return { cycleId: cycle.id, mode, executed: [], skipped: [], summary };
    }
    const unreviewed = await prisma.improvementProposal.count({ where: { companyId, productId, status: "IN_PROGRESS" } });
    let room = Math.min(budget.maxChangesPerCycle - executed.length, budget.maxUnreviewed - unreviewed);
    const candidates = await prisma.improvementProposal.findMany({ where: { companyId, productId, status: { in: mode === "AUTONOMOUS" ? ["APPROVED", "OPEN"] : ["APPROVED"] } }, orderBy: { priority: "desc" } });
    for (const c of candidates) {
      // A person cancelled the cycle: stop at the next step (checkpoint keeps what already happened).
      if ((await prisma.maintenanceCycle.findUnique({ where: { id: cycle.id }, select: { status: true } }))?.status === "CANCELLED") return { cycleId: cycle.id, mode, executed, skipped, summary: "cancelled" };
      if (Date.now() - started > budget.maxCycleMs) { skipped.push({ id: c.id, why: "cycle time budget reached" }); break; }
      if (executed.includes(c.id)) continue;
      if (c.status === "OPEN" && c.approval === "required") { skipped.push({ id: c.id, why: "needs approval (sensitive, risky or mandatory)" }); continue; }
      if (c.attempts >= budget.maxAttemptsPerIssue) {
        await prisma.improvementProposal.update({ where: { id: c.id }, data: { status: "FAILED", outcome: JSON.stringify({ result: "escalated", reason: `failed verification ${c.attempts} time(s); automatic attempts stopped`, objectiveMet: null }) } });
        await prisma.notification.upsert({ where: { companyId_dedupeKey: { companyId, dedupeKey: `maint-escalate:${c.id}` } }, create: { companyId, dedupeKey: `maint-escalate:${c.id}`, kind: "intervention", severity: "medium", title: `Maintenance needs a person: ${c.title}`.slice(0, 200), body: "Automatic attempts were stopped after repeated verification failures; evidence is preserved on the proposal.", href: `/products/${productId}?tab=evolution` }, update: {} });
        skipped.push({ id: c.id, why: "attempt budget exhausted → escalated" });
        continue;
      }
      if (room <= 0) { skipped.push({ id: c.id, why: "change budget for this cycle (or unreviewed-change limit) reached" }); continue; }
      const key = await enqueueProposal(companyId, productId, c, actor);
      executed.push(c.id);
      room--;
      await save({ ...cp, step: `enqueued ${key}`, executed, skipped });
    }
    const summary = `${mode.toLowerCase().replace("_", " ")}: ${executed.length} change(s) queued on isolated branches, ${skipped.length} skipped${executed.length === 0 ? " — no eligible change (the product may already be adequate)" : ""}. Nothing is released automatically.`;
    await prisma.maintenanceCycle.update({ where: { id: cycle.id }, data: { status: "COMPLETED", summary, finishedAt: new Date(), checkpoint: JSON.stringify({ ...cp, step: "done", executed, skipped }) } });
    if (executed.length) await productEvent(companyId, productId, summary, { actor: "product-manager" });
    return { cycleId: cycle.id, mode, executed, skipped, summary };
  } catch (e) {
    await prisma.maintenanceCycle.update({ where: { id: cycle.id }, data: { status: "FAILED", summary: (e as Error).message.slice(0, 500), finishedAt: new Date() } }).catch(() => null);
    log("warn", "maintenance.cycle_failed", { productId, error: (e as Error).message });
    throw e;
  }
}

/** Resume cycles a crashed worker left RUNNING (checkpoint continues; idempotent steps). */
export async function resumeCycles(companyId: string) {
  const stuck = await prisma.maintenanceCycle.findMany({ where: { companyId, status: "RUNNING", createdAt: { lt: new Date(Date.now() - 60_000) } } });
  const out: string[] = [];
  for (const c of stuck) { await runCycle(companyId, c.productId, c.createdBy, { cycleId: c.id }).catch(() => null); out.push(c.id); }
  return out;
}

/** Settle proposals from their backlog task's verified outcome; record whether the objective is known to be met. */
export async function settleProposals(companyId: string, productId: string) {
  const rows = await prisma.improvementProposal.findMany({ where: { companyId, productId, status: "IN_PROGRESS", itemKey: { not: null } } });
  for (const r of rows) {
    const it = await prisma.backlogItem.findFirst({ where: { productId, companyId, key: r.itemKey! } });
    if (!it) continue;
    if (it.status === "VERIFIED") {
      const b = it.buildId ? await prisma.build.findFirst({ where: { id: it.buildId, companyId }, select: { id: true, changed: true, criteria: true } }) : null;
      const noChange = b && parseJSON<string[]>(b.changed, []).length === 0;
      // The evidence that re-collection no longer sees the problem is the objective check; until then it is unknown.
      await prisma.improvementProposal.update({ where: { id: r.id }, data: { status: noChange ? "NO_CHANGE_NEEDED" : "DONE", outcome: JSON.stringify({ result: "verified", buildId: b?.id, objectiveMet: null, note: "verified by the pipeline; whether the underlying problem is gone is re-checked on the next analysis" }) } });
      await emitLearning({ companyId, type: "delivered", key: `proposal-done:${r.id}`, productId, payload: { proposal: r.id, source: r.source } });
    } else if (["FAILED", "BLOCKED"].includes(it.status)) {
      await prisma.improvementProposal.update({ where: { id: r.id }, data: { status: "APPROVED", outcome: JSON.stringify({ result: "verification_failed", item: it.key, objectiveMet: false }) } });
      await prisma.backlogItem.update({ where: { id: it.id }, data: { status: "CANCELLED" } });
    }
  }
  // A DONE proposal whose problem is no longer detected by the latest analysis met its objective.
  const done = await prisma.improvementProposal.findMany({ where: { companyId, productId, status: "DONE" } });
  const latestCollect = await prisma.improvementProposal.findFirst({ where: { companyId, productId }, orderBy: { lastSeenAt: "desc" }, select: { lastSeenAt: true } });
  for (const d of done) {
    const o = parseJSON<{ objectiveMet?: boolean | null }>(d.outcome, {});
    if (o.objectiveMet === null && latestCollect && latestCollect.lastSeenAt > d.updatedAt && d.lastSeenAt < latestCollect.lastSeenAt) await prisma.improvementProposal.update({ where: { id: d.id }, data: { outcome: JSON.stringify({ ...o, objectiveMet: true, note: "the problem is no longer detected by the latest analysis" }) } });
  }

}

/** A user's own improvement request becomes a proposal (explicit → no invented evidence; approval per policy). */
export async function addRequest(companyId: string, productId: string, actor: string, input: { title: string; problem: string; components?: string[] }) {
  await loadProduct(companyId, productId);
  const fingerprint = `request:${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80)}`;
  const data = { source: "user_request", title: input.title.slice(0, 200), problem: input.problem.slice(0, 2000), evidence: JSON.stringify([{ kind: "user_request", ref: actor, detail: input.problem.slice(0, 200) }]), components: JSON.stringify(input.components ?? []), benefit: "medium — requested by a user (benefit not measured)", effort: "medium", uncertainty: "medium", risk: /auth|password|secret|migration|schema/i.test(`${input.title} ${input.problem}`) ? "high" : "low", approval: "required", verification: JSON.stringify(["requested behaviour verified by tests", "All pre-existing tests still pass"]), lastSeenAt: new Date() };
  const p = await prisma.improvementProposal.upsert({ where: { productId_fingerprint: { productId, fingerprint } }, create: { companyId, productId, fingerprint, ...data }, update: data });
  await prioritize(companyId, productId);
  await audit(companyId, actor, "PROPOSAL_REQUESTED", p.id, p.title);
  return p;
}
