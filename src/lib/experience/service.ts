/**
 * Product experience audits (V17): durable job → checkout of the product's
 * integration base (latest verified release, else the default branch) →
 * static inspection → the app running in AURA's isolated container → real
 * Chromium inspection + journeys derived from the brief → findings merged,
 * deduplicated by fingerprint across audits (FIXED / REOPENED tracked on one
 * row), compared with the previous audit (regressions), scored with stated
 * formulas. Findings feed the EXISTING backlog (one task per finding, through
 * the normal builder/scheduler with its approvals, budgets and limits) and the
 * existing project memory (verified fixes only).
 *
 * Unavailable capability = recorded limitation, never a pass.
 */
import { join } from "node:path";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { parseJSON } from "@/lib/utils";
import { enqueue, JobError } from "@/lib/jobs/queue";

import { audit as auditLog } from "@/lib/events/emit";
import { log } from "@/lib/observability/log";
import { loadProduct, assertNotArchived, productEvent } from "@/lib/factory/store";
import { integrationBase } from "@/lib/factory/base";
import { remember } from "@/lib/factory/memory";
import { assessRisk } from "@/lib/builder/orchestrator";
import { openTree, closeTree, listTree, readTreeFile } from "@/lib/builder/workspace";
import { buildIndex, dependentsOf } from "@/lib/builder/intel";
import { startIsolatedApp, launchChromium, routesFrom, collectionRoutes, evidenceRoot } from "@/lib/builder/browser";
import { staticInspect, browserInspect, viewportsFor } from "./inspect";
import { toFinding, mergeFindings, priorityOf, remediationPolicy, scoreAudit, regressionsAgainst, journeysFrom, type Finding, type Observation } from "./rubric";

export const AUDIT_JOB = "experience.audit";
const ACTIVE = ["OPEN", "REOPENED", "IN_PROGRESS"];

export async function requestAudit(companyId: string, productId: string, actor: string, trigger: "manual" | "build" | "change" = "manual") {
  const p = await loadProduct(companyId, productId);
  assertNotArchived(p);
  if (!p.repoId) throw new ApiError("This product has no repository yet — plan it first", 409);
  // One audit at a time per product (bounded; a second request returns the running one).
  const running = await prisma.experienceAudit.findFirst({ where: { companyId, productId, status: { in: ["QUEUED", "RUNNING"] } } });
  if (running) return running;
  const a = await prisma.experienceAudit.create({ data: { companyId, productId, trigger, createdBy: actor } });
  const job = await enqueue({ companyId, type: AUDIT_JOB, payload: { auditId: a.id }, dedupeKey: `experience:${a.id}`, maxAttempts: 2, createdBy: actor, concurrencyKey: `experience:${productId}`, timeoutMs: 15 * 60_000 });
  await prisma.experienceAudit.update({ where: { id: a.id }, data: { jobId: job.id } });
  await auditLog(companyId, actor, "EXPERIENCE_AUDIT_REQUESTED", productId, trigger, { category: "execution" });
  return { ...a, jobId: job.id };
}

async function inspectTree(companyId: string, productId: string, auditId: string, dir: string, files: Record<string, string>, brief: Parameters<typeof journeysFrom>[0], signal?: AbortSignal) {
  const methods: Record<string, string> = { static: "ran" };
  const limitations: string[] = [];
  const obs: (Observation & { _help?: string })[] = staticInspect(files);
  const index = await buildIndex(files);
  const pages = routesFrom(Object.keys(files));
  const collections = collectionRoutes(index.routes);
  const specs = journeysFrom(brief, { collections, pages });
  let routes: { route: string; viewport: string; httpStatus: number | null; screenshot: string | null }[] = [];
  let journeys: Awaited<ReturnType<typeof browserInspect>>["journeys"] = specs.map((s) => ({ id: s.id, name: s.name, requirements: s.requirements, critical: s.critical, status: "not_run" as const, steps: [], detail: "browser session did not run" }));
  let forms = { total: 0, withValidationFeedback: 0, withRecovery: 0 };
  let browserRan = false;
  if (!files["src/server.js"]) {
    methods.browser = "unavailable: no runnable web entry point (src/server.js)";
  } else {
    const started = await startIsolatedApp({ treeDir: dir, id: auditId });
    if ("unavailable" in started) methods.browser = `unavailable: ${started.unavailable}`;
    else if ("failed" in started) {
      methods.browser = "ran (app did not start)";
      browserRan = true;
      obs.push({ rule: "page:load_failed", method: "browser", route: "/", detail: `${started.failed} Container log: ${started.log.slice(-600)}`, files: ["src/server.js"], evidence: [{ kind: "container_log", ref: "app", detail: started.log.slice(-300) }] });
      journeys = journeys.map((j) => ({ ...j, status: "failed" as const, detail: "the app did not start" }));
      await started.stop();
    } else {
      const ch = await launchChromium();
      if ("unavailable" in ch) { methods.browser = `unavailable: ${ch.unavailable}`; await started.app.stop(); }
      else {
        try {
          const r = await browserInspect({ browser: ch.browser, base: started.app.base, pages, viewports: viewportsFor(files), journeys: specs, collections, evidenceDir: join(evidenceRoot(), companyId, "experience", auditId), signal, files });
          obs.push(...r.observations);
          routes = r.routes;
          journeys = r.journeys;
          forms = r.forms;
          methods.browser = "ran";
          methods.axe = r.axe;
          browserRan = true;
        } finally {
          await ch.browser.close().catch(() => null);
          await started.app.stop();
        }
      }
    }
  }
  if (!browserRan) limitations.push(`No browser session: ${methods.browser.replace(/^unavailable: /, "")}. Only static source checks ran; journeys, interaction, accessibility and responsive checks are NOT verified.`);
  if (methods.axe && methods.axe !== "ran") limitations.push(`axe-core ${methods.axe}`);
  limitations.push("Automated accessibility checks (axe-core + keyboard/focus probes) do not prove WCAG 2.2 AA compliance; screen-reader and manual assistive-technology testing are not performed.");
  limitations.push("Clarity findings are hypotheses from heuristics — no user research or analytics are connected.");
  // Trace findings to files that implement the affected route (static index) and to requirements via journeys.
  const findings = mergeFindings(obs.map((o) => toFinding(o, { help: o._help ?? o.rule })));
  return { findings, routes, journeys, forms, methods, limitations, browserRan, index };
}

/** Durable job body. Idempotent: a re-run of a COMPLETED audit is a no-op. */
export async function runAudit(auditId: string, signal?: AbortSignal) {
  const a = await prisma.experienceAudit.findUnique({ where: { id: auditId } });
  if (!a) throw new JobError("Audit not found", false, "missing");
  if (["COMPLETED", "CANCELLED", "FAILED"].includes(a.status)) return { status: a.status };
  const p = await prisma.product.findFirst({ where: { id: a.productId, companyId: a.companyId } });
  const repo = p?.repoId ? await prisma.repoConnection.findFirst({ where: { id: p.repoId, companyId: a.companyId } }) : null;
  if (!p || !repo) throw new JobError("Product or repository no longer exists", false, "missing");
  await prisma.experienceAudit.update({ where: { id: a.id }, data: { status: "RUNNING" } });
  const base = await integrationBase(a.companyId, a.productId, repo);
  const tree = await openTree(a.companyId, repo.id, `xa-${a.id}`, base.branch, base.branch);
  try {
    const files: Record<string, string> = {};
    for (const f of await listTree(tree)) if (/\.(c|m)?(j|t)sx?$|\.(json|html?|css)$/.test(f) && f !== "package-lock.json") files[f] = (await readTreeFile(tree, f)) ?? "";
    const brief = parseJSON<Parameters<typeof journeysFrom>[0]>((await prisma.productBrief.findFirst({ where: { productId: p.id }, orderBy: { version: "desc" } }))?.content, null);
    const r = await inspectTree(a.companyId, a.productId, a.id, tree.dir, files, brief, signal);
    const shared = sharedComponents(r.index);
    const saved = await persistFindings(a.companyId, a.productId, a.id, r.findings, { browserRan: r.browserRan, shared });
    const baseline = await prisma.experienceAudit.findFirst({ where: { companyId: a.companyId, productId: a.productId, status: "COMPLETED", id: { not: a.id } }, orderBy: { createdAt: "desc" } });
    const baseFps = baseline ? new Set((await prisma.experienceFinding.findMany({ where: { productId: a.productId, companyId: a.companyId, OR: [{ lastAuditId: baseline.id }, { firstAuditId: baseline.id }] }, select: { fingerprint: true, status: true, lastAuditId: true } })).filter((f) => f.lastAuditId === baseline.id || ACTIVE.includes(f.status)).map((f) => f.fingerprint)) : null;
    const regressions = regressionsAgainst(r.findings, baseFps);
    const reqTotal = (brief?.functional?.length ?? 0) + (brief?.acceptance?.length ?? 0);
    const score = scoreAudit({ journeys: r.journeys, findings: r.findings, forms: r.forms, browserRan: r.browserRan, requirementsTotal: reqTotal });
    await prisma.experienceAudit.update({ where: { id: a.id }, data: { status: "COMPLETED", sha: tree.baseSha, branch: base.branch, methods: JSON.stringify(r.methods), routes: JSON.stringify(r.routes), journeys: JSON.stringify(r.journeys), score: JSON.stringify({ ...score, fixed: saved.fixed, reopened: saved.reopened }), limitations: JSON.stringify(r.limitations), baselineId: baseline?.id ?? null, regressions: JSON.stringify(regressions), finishedAt: new Date() } });
    await productEvent(a.companyId, a.productId, `Experience audit @ ${tree.baseSha.slice(0, 8)}: ${r.findings.length} finding(s), ${score.criticalFailures.length} critical failure(s)${regressions.length ? `, ${regressions.length} regression(s) vs the previous audit` : ""}${r.browserRan ? "" : " — browser NOT run (static checks only)"}`, { actor: "qa-engineer", level: score.criticalFailures.length || regressions.length ? "warning" : "info" });
    return { status: "COMPLETED", findings: r.findings.length, regressions: regressions.length };
  } catch (e) {
    const retryable = (e as { retryable?: boolean }).retryable;
    if (!retryable) await prisma.experienceAudit.update({ where: { id: a.id }, data: { status: (e as Error).message === "cancelled" ? "CANCELLED" : "FAILED", error: (e as Error).message.slice(0, 1000), finishedAt: new Date() } });
    log("warn", "experience.audit_failed", { auditId, error: (e as Error).message });
    throw e;
  } finally {
    await closeTree(tree);
  }
}

/** Files imported by ≥3 others are shared components (changes there need broader regression testing). */
function sharedComponents(index: Awaited<ReturnType<typeof buildIndex>>) {
  return index.files.map((f) => f.path).filter((p) => dependentsOf(index, [p]).length >= 3);
}

/**
 * Upsert findings by fingerprint. Status transitions (all evidence-based):
 *  - new → OPEN
 *  - FIXED and seen again → REOPENED (reopened++)
 *  - active and NOT seen by a browser-backed audit (and its method ran) → FIXED
 * Static-only audits never mark browser findings fixed (absence of evidence ≠ fixed).
 */
export async function persistFindings(companyId: string, productId: string, auditId: string, findings: Finding[], ctx: { browserRan: boolean; shared: string[] }) {
  const now = new Date();
  let reopened = 0;
  for (const f of findings) {
    const pr = priorityOf(f, { sharedFiles: ctx.shared, sensitive: remediationPolicy(f, { sharedFiles: ctx.shared }).mode === "approval" });
    const data = { dimension: f.dimension, rule: f.rule, title: f.title, detail: f.detail, route: f.route, viewport: f.viewport, target: f.target, files: JSON.stringify(f.files), requirements: JSON.stringify(f.requirements), journey: f.journey, severity: f.severity, confidence: f.confidence, method: f.method, impact: f.impact, recommendation: f.recommendation, evidence: JSON.stringify([...f.evidence, { kind: "priority", ref: String(pr.score), detail: pr.why.join("; ") }]), manualCheck: f.manualCheck, lastAuditId: auditId, lastSeenAt: now };
    const prev = await prisma.experienceFinding.findUnique({ where: { productId_fingerprint: { productId, fingerprint: f.fingerprint } } });
    if (prev && prev.companyId !== companyId) throw new ApiError("Finding scope mismatch", 403);
    if (!prev) await prisma.experienceFinding.create({ data: { companyId, productId, fingerprint: f.fingerprint, firstAuditId: auditId, history: JSON.stringify([{ at: now.toISOString(), audit: auditId, change: "found" }]), ...data } });
    else {
      const back = prev.status === "FIXED";
      if (back) reopened++;
      await prisma.experienceFinding.update({ where: { id: prev.id }, data: { ...data, ...(back ? { status: "REOPENED", reopened: { increment: 1 }, fixedAt: null } : {}), history: JSON.stringify([...parseJSON<unknown[]>(prev.history, []), ...(back ? [{ at: now.toISOString(), audit: auditId, change: "seen again after a fix → reopened" }] : [])].slice(-40)) } });
    }
  }
  const seen = findings.map((f) => f.fingerprint);
  const methodsCovered = ctx.browserRan ? ["static", "browser", "axe", "journey"] : ["static"];
  const gone = await prisma.experienceFinding.findMany({ where: { companyId, productId, status: { in: ACTIVE }, fingerprint: { notIn: seen }, method: { in: methodsCovered } } });
  for (const g of gone) await prisma.experienceFinding.update({ where: { id: g.id }, data: { status: "FIXED", fixedAt: now, fixedByAuditId: auditId, history: JSON.stringify([...parseJSON<unknown[]>(g.history, []), { at: now.toISOString(), audit: auditId, change: "no longer observed by a re-audit → fixed" }].slice(-40)) } });
  // Verified outcome → engineering memory (only for fixes that came from an AURA task, i.e. a real change).
  for (const g of gone.filter((x) => x.itemKey)) await remember({ companyId, productId, key: `ux:${g.rule}:${g.route}`, kind: "defect_solution", content: `UX finding "${g.title}" (${g.rule} on ${g.route || "app"}) was fixed by task ${g.itemKey}; re-audit ${auditId.slice(-6)} no longer observes it. Fix approach: ${g.recommendation}`, status: "VERIFIED", files: parseJSON<string[]>(g.files, []), provenance: { type: "build", ref: g.itemKey!, detail: `experience re-audit ${auditId}` } }).catch(() => null);
  return { fixed: gone.length, reopened };
}

// ---------------------------------------------------------------------------
// Finding → backlog task (existing scheduler/builder/approvals do the rest)
// ---------------------------------------------------------------------------

export async function createTaskFromFinding(companyId: string, productId: string, findingId: string, actor: { email: string; role: string }) {
  const f = await prisma.experienceFinding.findFirst({ where: { id: findingId, companyId, productId } });
  if (!f) throw new ApiError("Finding not found", 404);
  if (!["OPEN", "REOPENED"].includes(f.status)) throw new ApiError(`Finding is ${f.status.toLowerCase().replace("_", " ")}`, 409);
  if (f.itemKey) {
    const existing = await prisma.backlogItem.findFirst({ where: { productId, companyId, key: f.itemKey } });
    if (existing && !["CANCELLED", "FAILED", "BLOCKED"].includes(existing.status)) return { itemKey: existing.key, created: false, policy: remediationPolicy({ ...f, files: parseJSON<string[]>(f.files, []) }) };
  }
  const MAX_ATTEMPTS = 2;
  if (f.attempts >= MAX_ATTEMPTS) throw new ApiError(`Automatic fixes for this finding already failed ${f.attempts} time(s); it needs a person (evidence is kept on the finding)`, 409);
  const p = await loadProduct(companyId, productId);
  assertNotArchived(p);
  const files = parseJSON<string[]>(f.files, []).filter((x) => !/^\.env/.test(x));
  const policy = remediationPolicy({ ...f, files });
  if (policy.mode === "recommend") throw new ApiError(`Not turned into a task automatically: ${policy.why}. Confirm it with users first, or describe the change as a request.`, 422);
  if (policy.mode === "approval" && !["ADMIN", "OWNER"].includes(actor.role)) throw new ApiError(`This change needs an admin: ${policy.why}`, 403);
  const story = "UX1";
  if (!(await prisma.backlogItem.findFirst({ where: { productId, key: story } }))) await prisma.backlogItem.create({ data: { productId, companyId, key: story, level: "STORY", title: "Product experience fixes", acceptance: JSON.stringify(["Each fix is verified by a re-audit and the regression suite"]), milestone: "EXPERIENCE", history: JSON.stringify([{ at: new Date().toISOString(), actor: actor.email, change: "experience story" }]) } });
  const n = await prisma.backlogItem.count({ where: { productId, parentKey: story } });
  const key = `${story}.T${n + 1}`;
  const evidence = parseJSON<{ kind: string; ref: string; detail: string }[]>(f.evidence, []).filter((e) => e.kind !== "priority");
  const acceptance = [
    `${f.title} is no longer observed${f.route ? ` on ${f.route}` : ""}${f.viewport ? ` (${f.viewport})` : ""}: ${f.recommendation}`,
    ...(f.journey ? [`The journey "${f.journey}" passes end to end in the browser`] : []),
    "Automated tests cover the corrected behaviour",
    "All pre-existing tests still pass",
  ].slice(0, 6);
  const kind = files.some((x) => /^src\/(routes|server|app|store)/.test(x)) && !files.some((x) => /^public\//.test(x)) ? "BACKEND" : "FRONTEND";
  const risk = assessRisk({ risk: f.severity === "low" ? "LOW" : "MEDIUM", title: f.title, description: f.detail, acceptance, files }).risk;
  await prisma.backlogItem.create({ data: { productId, companyId, key, level: "TASK", kind, parentKey: story, title: `UX: ${f.title}${f.route ? ` (${f.route})` : ""}`.slice(0, 160), description: `${f.detail}\n\nObserved evidence (experience audit ${f.lastAuditId.slice(-6)}):\n${evidence.map((e) => `- [${e.kind}] ${e.ref}: ${e.detail}`).join("\n").slice(0, 900)}\n\nUser impact: ${f.impact}\nRecommended fix: ${f.recommendation}\n\nPreserve the product's existing visual design, tokens and components; make the smallest change that resolves the observed problem.${policy.mode === "approval" ? `\nRisk note: ${policy.why}.` : ""}`.slice(0, 1800), acceptance: JSON.stringify(acceptance), files: JSON.stringify(files), risk, capabilities: JSON.stringify([kind === "FRONTEND" ? "frontend-engineer" : "backend-engineer"]), verifyBy: JSON.stringify(["sandbox tests", "browser verification", "experience re-audit"]), executable: true, milestone: "EXPERIENCE", status: "READY", priority: f.severity === "critical" ? 90 : f.severity === "high" ? 70 : 40, requirements: f.requirements, history: JSON.stringify([{ at: new Date().toISOString(), actor: actor.email, change: `from experience finding ${f.id.slice(-6)} (${policy.mode}: ${policy.why})` }]) } });
  await prisma.experienceFinding.update({ where: { id: f.id }, data: { status: "IN_PROGRESS", itemKey: key, attempts: { increment: 1 }, history: JSON.stringify([...parseJSON<unknown[]>(f.history, []), { at: new Date().toISOString(), change: `task ${key} created by ${actor.email}` }].slice(-40)) } });
  await auditLog(companyId, actor.email, "EXPERIENCE_TASK_CREATED", f.id, `${key}: ${f.title}`.slice(0, 200), { category: "execution" });
  return { itemKey: key, created: true, policy };
}

/**
 * Settle findings whose task finished (called by the scheduler tick):
 *  - task VERIFIED → re-audit (the finding becomes FIXED only if the re-audit no longer observes it)
 *  - task FAILED/BLOCKED → back to OPEN with the attempt counted (bounded by createTaskFromFinding)
 */
export async function settleExperience(companyId: string, productId: string) {
  const rows = await prisma.experienceFinding.findMany({ where: { companyId, productId, status: "IN_PROGRESS", itemKey: { not: null } } });
  let reaudit = false;
  for (const f of rows) {
    const it = await prisma.backlogItem.findFirst({ where: { productId, companyId, key: f.itemKey! } });
    if (!it) continue;
    if (it.status === "VERIFIED") reaudit = true;
    else if (["FAILED", "BLOCKED", "CANCELLED"].includes(it.status)) await prisma.experienceFinding.update({ where: { id: f.id }, data: { status: "OPEN", history: JSON.stringify([...parseJSON<unknown[]>(f.history, []), { at: new Date().toISOString(), change: `task ${it.key} ${it.status.toLowerCase()} — finding stays open` }].slice(-40)) } });
  }
  if (reaudit) {
    const after = await prisma.experienceAudit.findFirst({ where: { companyId, productId, status: { in: ["QUEUED", "RUNNING"] } } });
    if (!after) await requestAudit(companyId, productId, "scheduler", "change");
  }
}

const BROWSER_TO_RULES: Record<string, string[]> = {
  overflow: ["responsive:overflow"],
  unlabeled_control: ["a11y:unlabeled_field", "axe:label", "axe:button-name", "axe:link-name", "axe:select-name", "axe:input-button-name"],
  page_error: ["page:error"],
  console_error: ["page:console_error"],
  request_failed: ["page:request_failed"],
  load_failed: ["page:load_failed"],
};

/**
 * Build browser findings that an experience audit ALREADY observed on the
 * product's base (open finding, same rule family, route and viewport) were
 * not introduced by this change. They stay visible, labelled pre-existing,
 * but do not block a targeted fix — they are tracked as their own findings.
 * Journey failures are never matched (the task's own journeys must pass).
 */
export async function preexistingExperience(companyId: string, productId: string, fs: { kind: string; route: string; viewport: string }[]) {
  const open = await prisma.experienceFinding.findMany({ where: { companyId, productId, status: { in: ["OPEN", "REOPENED"] } }, select: { id: true, rule: true, route: true, viewport: true } });
  return fs.map((f) => open.find((o) => (BROWSER_TO_RULES[f.kind] ?? []).includes(o.rule) && o.route === f.route && (!o.viewport || o.viewport.split(",").includes(f.viewport)))?.id ?? null);
}

export async function setFindingStatus(companyId: string, productId: string, findingId: string, actor: string, status: "ACCEPTED_RISK" | "DISMISSED" | "OPEN", note: string) {
  const f = await prisma.experienceFinding.findFirst({ where: { id: findingId, companyId, productId } });
  if (!f) throw new ApiError("Finding not found", 404);
  if (f.status === "IN_PROGRESS" && status !== "OPEN") throw new ApiError("A task is working on this finding", 409);
  if (status !== "OPEN" && f.severity === "critical") throw new ApiError("Critical findings cannot be dismissed or accepted; fix the journey", 422);
  await prisma.experienceFinding.update({ where: { id: f.id }, data: { status, history: JSON.stringify([...parseJSON<unknown[]>(f.history, []), { at: new Date().toISOString(), change: `${status.toLowerCase()} by ${actor}${note ? `: ${note}` : ""}` }].slice(-40)) } });
  await auditLog(companyId, actor, `EXPERIENCE_FINDING_${status}`, f.id, note.slice(0, 200));
}

// ---------------------------------------------------------------------------
// Read model for the workspace
// ---------------------------------------------------------------------------

export async function experienceOverview(companyId: string, productId: string) {
  await loadProduct(companyId, productId);
  const audits = await prisma.experienceAudit.findMany({ where: { companyId, productId }, orderBy: { createdAt: "desc" }, take: 10 });
  const latest = audits.find((x) => x.status === "COMPLETED") ?? null;
  const findings = await prisma.experienceFinding.findMany({ where: { companyId, productId }, orderBy: [{ updatedAt: "desc" }], take: 300 });
  const items = await prisma.backlogItem.findMany({ where: { companyId, productId, key: { in: findings.map((f) => f.itemKey).filter(Boolean) as string[] } }, select: { key: true, status: true, buildId: true } });
  const view = (a: (typeof audits)[number]) => ({ id: a.id, status: a.status, trigger: a.trigger, sha: a.sha, branch: a.branch, createdAt: a.createdAt, finishedAt: a.finishedAt, error: a.error, methods: parseJSON<Record<string, string>>(a.methods, {}), routes: parseJSON<{ route: string; viewport: string; httpStatus: number | null; screenshot: string | null }[]>(a.routes, []).map((r, i) => ({ ...r, screenshot: r.screenshot ? i : null })), journeys: parseJSON<unknown[]>(a.journeys, []), score: parseJSON<Record<string, unknown>>(a.score, {}), limitations: parseJSON<string[]>(a.limitations, []), baselineId: a.baselineId, regressions: parseJSON<string[]>(a.regressions, []) });
  return {
    audits: audits.map(view),
    latest: latest ? view(latest) : null,
    findings: findings.map((f) => {
      const files = parseJSON<string[]>(f.files, []);
      const ev = parseJSON<{ kind: string; ref: string; detail: string }[]>(f.evidence, []);
      const pr = ev.find((e) => e.kind === "priority");
      return { id: f.id, fingerprint: f.fingerprint, dimension: f.dimension, rule: f.rule, title: f.title, detail: f.detail, route: f.route, viewport: f.viewport, target: f.target, files, requirements: parseJSON<string[]>(f.requirements, []), journey: f.journey, severity: f.severity, confidence: f.confidence, method: f.method, impact: f.impact, recommendation: f.recommendation, evidence: ev.filter((e) => e.kind !== "priority"), priority: pr ? { score: Number(pr.ref), why: pr.detail } : null, manualCheck: f.manualCheck, status: f.status, reopened: f.reopened, itemKey: f.itemKey, item: items.find((i) => i.key === f.itemKey) ?? null, attempts: f.attempts, policy: remediationPolicy({ ...f, files }), history: parseJSON<{ at: string; change: string }[]>(f.history, []), firstAuditId: f.firstAuditId, lastAuditId: f.lastAuditId, fixedAt: f.fixedAt, updatedAt: f.updatedAt };
    }),
  };
}

export async function auditScreenshot(companyId: string, productId: string, auditId: string, n: number) {
  const a = await prisma.experienceAudit.findFirst({ where: { id: auditId, companyId, productId } });
  if (!a) throw new ApiError("Audit not found", 404);
  return { file: parseJSON<{ screenshot: string | null }[]>(a.routes, [])[n]?.screenshot ?? null, root: join(evidenceRoot(), companyId, "experience", a.id) };
}
