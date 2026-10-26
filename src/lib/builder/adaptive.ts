/**
 * Adaptive execution intelligence for one engineering task (pure,
 * deterministic, versioned, unit-tested). The engine (engine.ts) executes;
 * this module decides HOW, from evidence it is given:
 *
 *   classifyTask       category, scope, complexity, uncertainty, risk, research /
 *                      tool needs, collaboration need — each dimension with the
 *                      evidence that produced it and an overall confidence
 *   chooseStrategy     the least complicated strategy that meets the task's
 *                      correctness + risk requirements (direct · plan_then_execute ·
 *                      investigate_then_execute · test_driven_repair ·
 *                      sequential_handoff · collaborative · high_assurance)
 *   verificationPlan   checks required by risk + project policy (never lowered)
 *   toolPlan           which tools the task needs, by expected information value,
 *                      filtered by the owner's permissions and availability
 *   routeModel         provider/model choice honouring pins, data-handling
 *                      restrictions, availability and fallback policy
 *   adjust             the feedback controller: from real execution signals, a
 *                      bounded strategy change with a stated rationale, or stop
 *   collaborationValue whether splitting work across agents is worth it
 *
 * Nothing here marks work done or reads the model's self-assessment.
 * Policy versions are immutable; `ADAPTIVE_POLICIES` holds every version so a
 * run can be replayed and a promoted version rolled back.
 */
import type { Risk } from "./orchestrator";

export const TASK_CATEGORIES = ["discovery", "planning", "design", "implementation", "debugging", "testing", "refactoring", "security", "integration", "release"] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];
export const SCOPES = ["function", "component", "service", "application", "cross_project"] as const;
export type Scope = (typeof SCOPES)[number];
export const STRATEGIES = ["direct", "plan_then_execute", "investigate_then_execute", "test_driven_repair", "sequential_handoff", "collaborative", "high_assurance"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export interface Dimension<T> { value: T; evidence: string[] }
export interface Classification {
  category: Dimension<TaskCategory>;
  scope: Dimension<Scope>;
  complexity: Dimension<"low" | "medium" | "high">;
  uncertainty: Dimension<"low" | "medium" | "high">;
  dependents: Dimension<number>;
  familiarity: Dimension<"known" | "partial" | "new">;
  research: Dimension<boolean>;
  risk: Dimension<Risk>;
  verificationDepth: Dimension<"targeted" | "standard" | "deep">;
  collaboration: Dimension<"single" | "handoff" | "parallel">;
  deterministic: Dimension<boolean>;
  ambiguity: { blocking: boolean; questions: string[] };
  confidence: number; // 0..1: share of dimensions decided by direct evidence (not defaults)
  fastPath: boolean; // small, clear task: classification stopped early
}

export interface TaskEvidence {
  key: string;
  kind: string; // BACKEND | FRONTEND | DATA | TEST | DOCS | DESIGN | ARCHITECTURE | REPAIR level → see `level`
  level: string; // TASK | REPAIR
  title: string;
  description: string;
  acceptance: string[];
  files: string[];
  dependsOn: string[];
  plannedRisk: string;
  assessedRisk: Risk;
  riskReasons: string[];
  /** Files that exist in the repository snapshot the task starts from. */
  repoFiles: string[];
  /** Files that (transitively) import the planned files (static dependency graph). */
  dependents: string[];
  /** Open defects of earlier attempts / runs for this task (real failures). */
  openDefects: { category: string; occurrences: number; failingTests: string[] }[];
  /** Earlier runs of this task (any status). */
  priorRuns: { status: string; attempts: number; stopReason: string }[];
  /** Recent outcomes in this project for the same task kind (learning). */
  history: { firstPassSuccess: boolean; outcome: string }[];
  /** External services / packages referenced by the task text or planned files. */
  externalApis: string[];
}

const words = (s: string) => s.toLowerCase();
const has = (re: RegExp, s: string) => re.test(s);

/**
 * Classify a task from its evidence. Small, clear tasks take a fast path
 * (fewer dimensions computed, high confidence) — classification must not cost
 * more than the task.
 */
export function classifyTask(t: TaskEvidence): Classification {
  const text = words(`${t.title}\n${t.description}\n${t.acceptance.join("\n")}`);
  const ev = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean) as string[];
  let decided = 0;
  const total = 10;

  // Category: debugging when real defects exist or the text describes a defect; otherwise from kind + verbs.
  const defectText = has(/\b(bug|fix|broken|fails?|failing|error|crash|regression|wrong|incorrect|does not|doesn't|not working)\b/, text);
  const category: Dimension<TaskCategory> =
    t.level === "REPAIR" || t.openDefects.length ? { value: "debugging", evidence: ev(t.level === "REPAIR" && "repair task", t.openDefects.length > 0 && `${t.openDefects.length} open defect(s) from executed checks`) }
    : t.assessedRisk === "HIGH" && t.riskReasons.includes("authentication/authorization") ? { value: "security", evidence: ["touches authentication/authorization"] }
    : defectText ? { value: "debugging", evidence: ["task text describes a defect"] }
    : has(/\b(refactor|extract|rename|clean ?up|restructure|simplif)/, text) ? { value: "refactoring", evidence: ["task text asks for a refactor"] }
    : t.kind === "TEST" || has(/\b(add tests?|test coverage|regression tests?)\b/, text) ? { value: "testing", evidence: [t.kind === "TEST" ? "TEST task" : "task text asks for tests"] }
    : t.kind === "DESIGN" ? { value: "design", evidence: ["DESIGN task"] }
    : t.kind === "ARCHITECTURE" ? { value: "planning", evidence: ["ARCHITECTURE task"] }
    : t.externalApis.length || has(/\b(integrat|webhook|third[- ]party|external api|sdk)\w*/, text) ? { value: "integration", evidence: ev(t.externalApis.length > 0 && `external: ${t.externalApis.join(", ")}`, "task text mentions an integration") }
    : { value: "implementation", evidence: [`${t.kind} task`] };
  decided++;

  const newFiles = t.files.filter((f) => !t.repoFiles.includes(f));
  const familiarity: Dimension<"known" | "partial" | "new"> = !t.files.length ? { value: "partial", evidence: ["no planned files: the right files must be found"] } : newFiles.length === 0 ? { value: "known", evidence: [`all ${t.files.length} planned file(s) exist`] } : newFiles.length === t.files.length ? { value: "new", evidence: [`${newFiles.length} planned file(s) are new`] } : { value: "partial", evidence: [`${newFiles.length} of ${t.files.length} planned file(s) are new`] };
  if (t.files.length) decided++;

  const scope: Dimension<Scope> = t.dependents.length > 8 || t.files.length > 5 ? { value: "application", evidence: [`${t.files.length} planned file(s), ${t.dependents.length} dependent file(s)`] } : t.kind === "FRONTEND" && t.files.length <= 2 && t.dependents.length <= 2 ? { value: "component", evidence: ["small UI change"] } : t.files.length <= 1 && t.dependents.length <= 1 ? { value: "function", evidence: [`${t.files.length} file, ${t.dependents.length} dependent`] } : { value: "service", evidence: [`${t.files.length} planned file(s), ${t.dependents.length} dependent file(s)`] };
  decided++;
  const dependents: Dimension<number> = { value: t.dependents.length, evidence: [t.dependents.length ? `importers: ${t.dependents.slice(0, 5).join(", ")}${t.dependents.length > 5 ? "…" : ""}` : "nothing imports the planned files"] };
  decided++;

  const recurring = t.openDefects.some((d) => d.occurrences >= 2) || t.priorRuns.some((r) => ["FAILED", "BLOCKED"].includes(r.status));
  const failRate = t.history.length >= 3 ? t.history.filter((h) => !h.firstPassSuccess).length / t.history.length : null;
  const complexity: Dimension<"low" | "medium" | "high"> = scope.value === "application" || t.acceptance.length > 5 || recurring ? { value: "high", evidence: ev(scope.value === "application" && "application-wide scope", t.acceptance.length > 5 && `${t.acceptance.length} acceptance criteria`, recurring && "earlier attempts failed on this task") } : (scope.value === "function" || scope.value === "component") && t.acceptance.length <= 2 ? { value: "low", evidence: [`one ${scope.value}, ≤2 criteria`] } : { value: "medium", evidence: [`${t.files.length} file(s), ${t.acceptance.length} criteria`] };
  decided++;

  // Ambiguity: material only when it changes the implementation (no criteria, or vague verbs with no files).
  const vague = has(/\b(improve|better|nicer|clean ?up|optimi[sz]e|enhance|modernize)\b/, text) && !t.acceptance.some((a) => /\d|must|should|returns?|shows?|rejects?|accepts?/.test(a.toLowerCase()));
  const questions = [
    ...(t.acceptance.length === 0 ? ["What observable result makes this task done? (no acceptance criteria)"] : []),
    ...(vague ? [`"${t.title}" has no measurable target — what should change, by how much, and where?`] : []),
  ];
  const uncertainty: Dimension<"low" | "medium" | "high"> = questions.length ? { value: "high", evidence: questions } : familiarity.value !== "known" || category.value === "debugging" && !t.files.length || failRate !== null && failRate > 0.5 ? { value: "medium", evidence: ev(familiarity.value !== "known" && "planned files not all known", category.value === "debugging" && !t.files.length && "defect location unknown", failRate !== null && failRate > 0.5 && `first-pass failure rate ${Math.round(failRate * 100)}% on ${t.history.length} comparable task(s)`) } : { value: "low", evidence: ["criteria and files are concrete"] };
  decided++;

  const research: Dimension<boolean> = { value: t.externalApis.length > 0 && familiarity.value !== "known", evidence: t.externalApis.length ? [`external API(s) ${t.externalApis.join(", ")}${familiarity.value === "known" ? " already used in the repository" : " not yet used in the repository"}`] : ["no external API"] };
  decided++;
  const risk: Dimension<Risk> = { value: t.assessedRisk, evidence: t.riskReasons.length ? t.riskReasons : [`planned risk ${t.plannedRisk}`] };
  decided++;
  const verificationDepth: Dimension<"targeted" | "standard" | "deep"> = risk.value === "HIGH" ? { value: "deep", evidence: ["high risk"] } : risk.value === "LOW" && complexity.value === "low" ? { value: "targeted", evidence: ["low risk, low complexity"] } : { value: "standard", evidence: [`${risk.value.toLowerCase()} risk`] };
  const collaboration: Dimension<"single" | "handoff" | "parallel"> = t.kind === "FRONTEND" && t.dependsOn.length ? { value: "handoff", evidence: ["UI depends on upstream work (contracts/handoff)"] } : { value: "single", evidence: ["one owner can complete it; parallel split decided by collaborationValue()"] };
  const deterministic: Dimension<boolean> = { value: t.kind === "DOCS" || (category.value === "testing" && familiarity.value === "known" && complexity.value === "low"), evidence: [t.kind === "DOCS" ? "documentation" : "requires code generation"] };
  const fastPath = complexity.value === "low" && uncertainty.value === "low" && risk.value !== "HIGH" && !research.value;
  if (fastPath) decided = Math.max(decided, 9);
  return {
    category, scope, complexity, uncertainty, dependents, familiarity, research, risk, verificationDepth, collaboration, deterministic,
    ambiguity: { blocking: questions.length > 0 && (t.acceptance.length === 0 || risk.value === "HIGH"), questions },
    confidence: Math.round((decided / total) * 100) / 100,
    fastPath,
  };
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export interface PlanStep { key: string; title: string; agent: string; kind: "investigate" | "reproduce" | "plan" | "implement" | "verify" | "review" | "browser" | "integrate"; dependsOn: string[]; parallel: boolean; gate?: string }
export interface StrategyDecision { strategy: Strategy; why: string; steps: PlanStep[]; checkpoints: string[]; recovery: string; completion: string[] }

const RANK: Record<Strategy, number> = { direct: 0, plan_then_execute: 1, investigate_then_execute: 2, test_driven_repair: 2, sequential_handoff: 3, collaborative: 4, high_assurance: 5 };
export const strategyRank = (s: Strategy) => RANK[s];

/** Least complicated strategy that satisfies the classification's correctness + risk needs. */
export function chooseStrategy(c: Classification, ctx: { owner: string; reviewers: string[]; browser: boolean; parallelWorth: boolean; pinned?: Strategy }): StrategyDecision {
  let strategy: Strategy;
  let why: string;
  if (ctx.pinned) { strategy = ctx.pinned; why = `pinned by project policy`; }
  else if (c.risk.value === "HIGH") { strategy = "high_assurance"; why = `high risk (${c.risk.evidence.join(", ")}): deep verification + independent review`; }
  else if (c.category.value === "debugging") { strategy = "test_driven_repair"; why = "defect: reproduce with a failing test first, then fix and prove it"; }
  else if (c.uncertainty.value !== "low" || c.research.value) { strategy = "investigate_then_execute"; why = `uncertainty ${c.uncertainty.value}${c.research.value ? " + external API research" : ""}: gather repository evidence before changing code`; }
  else if (ctx.parallelWorth) { strategy = "collaborative"; why = "independent sub-parts with low file overlap: parallel work is worth the coordination"; }
  else if (c.collaboration.value === "handoff") { strategy = "sequential_handoff"; why = "depends on upstream contracts/handoff that must be honoured first"; }
  else if (c.complexity.value !== "low") { strategy = "plan_then_execute"; why = `${c.complexity.value} complexity: explicit implementation steps before coding`; }
  else { strategy = "direct"; why = "small, well-defined task: one capable agent implements and verifies"; }
  const s: PlanStep[] = [];
  const add = (p: Omit<PlanStep, "parallel"> & { parallel?: boolean }) => s.push({ parallel: false, ...p });
  if (strategy === "investigate_then_execute" || strategy === "high_assurance") add({ key: "investigate", title: "Read the relevant code, contracts and tests; state findings + risks before editing", agent: ctx.owner, kind: "investigate", dependsOn: [] });
  if (strategy === "test_driven_repair") add({ key: "reproduce", title: "Reproduce the defect with a failing test (must fail before the fix)", agent: ctx.owner, kind: "reproduce", dependsOn: [] });
  if (strategy === "plan_then_execute" || strategy === "sequential_handoff" || strategy === "collaborative") add({ key: "plan", title: strategy === "sequential_handoff" ? "Confirm the upstream contract/handoff this task must honour" : "Write the implementation steps and the files each touches", agent: ctx.owner, kind: "plan", dependsOn: [] });
  const prev = s.length ? [s[s.length - 1].key] : [];
  add({ key: "implement", title: "Implement with tests that prove each acceptance criterion", agent: ctx.owner, kind: "implement", dependsOn: prev, gate: strategy === "test_driven_repair" ? "reproducing test exists" : undefined });
  add({ key: "verify", title: "Engine runs impacted tests, then the full suite (+ lint/typecheck/build)", agent: "engine", kind: "verify", dependsOn: ["implement"], gate: "all engine checks pass" });
  if (ctx.browser) add({ key: "browser", title: "Render the app in Chromium (desktop + mobile) and check the journeys", agent: "qa-engineer", kind: "browser", dependsOn: ["verify"], gate: "no blocking browser finding" });
  for (const r of ctx.reviewers) add({ key: `review:${r}`, title: `Independent review by ${r}`, agent: r, kind: "review", dependsOn: [ctx.browser ? "browser" : "verify"], parallel: ctx.reviewers.length > 1, gate: strategy === "high_assurance" ? "explicit approve verdict" : "no evidenced blocking finding" });
  return {
    strategy, why, steps: s,
    checkpoints: ["after implementation (tree hash)", "after each verification (command runs persisted)", "after review (findings persisted)"],
    recovery: "feedback controller: category-specific repair; investigate/escalate/narrow on recurring or stalled failures; stop with the blocker after the adjustment budget",
    completion: ["every engine check exits 0", "every acceptance criterion met with evidence", ...(strategy === "high_assurance" ? ["explicit approval from every reviewer"] : []), ...(ctx.browser ? ["browser journeys pass or are recorded unavailable (unverified)"] : [])],
  };
}

// ---------------------------------------------------------------------------
// Verification depth (risk + mandatory project policy; never lowered)
// ---------------------------------------------------------------------------

export const CHECKS = ["unit_tests", "typecheck", "lint", "build", "integration_tests", "full_regression", "browser_journeys", "security_review", "code_review", "authorization_tests", "migration_validation", "explicit_approval"] as const;
export type CheckId = (typeof CHECKS)[number];

export function verificationRequirements(c: Classification, opts: { mandatory?: CheckId[]; ui: boolean; schemaChange: boolean }) {
  const req = new Map<CheckId, string>();
  const need = (id: CheckId, why: string) => { if (!req.has(id)) req.set(id, why); };
  need("unit_tests", "every change");
  need("code_review", "every change");
  need("full_regression", "existing behaviour must keep working");
  if (c.verificationDepth.value !== "targeted") need("integration_tests", `${c.verificationDepth.value} verification`);
  if (c.risk.value !== "LOW" || c.category.value === "security") need("security_review", `${c.risk.value.toLowerCase()} risk`);
  if (c.risk.evidence.includes("authentication/authorization") || c.category.value === "security") need("authorization_tests", "authorization surface changed");
  if (opts.schemaChange || c.risk.evidence.includes("data migration")) need("migration_validation", "data model changes");
  if (opts.ui) need("browser_journeys", "UI-visible change");
  if (c.risk.value === "HIGH") need("explicit_approval", "high risk: every reviewer must approve explicitly");
  for (const m of opts.mandatory ?? []) need(m, "mandated by project policy");
  return [...req.entries()].map(([id, why]) => ({ id, why }));
}

/** Compare required checks with what executed. Missing evidence = unverified, never silently passed. */
export function verificationStatus(required: { id: CheckId }[], executed: Partial<Record<CheckId, "passed" | "failed" | "unavailable">>) {
  const rows = required.map((r) => ({ id: r.id, status: executed[r.id] ?? ("not_run" as const) }));
  const failed = rows.filter((r) => r.status === "failed");
  const missing = rows.filter((r) => r.status === "not_run" || r.status === "unavailable");
  return { rows, verified: !failed.length && !missing.length, failed: failed.map((f) => f.id), unverified: missing.map((m) => m.id) };
}

// ---------------------------------------------------------------------------
// Tool selection
// ---------------------------------------------------------------------------

export interface ToolChoice { tool: string; why: string; available: boolean; permitted: boolean }

/** Tools by expected information value for this task; never "everything". */
export function toolPlan(c: Classification, ctx: { permitted: string[]; available: Record<string, boolean>; ui: boolean; hasTypecheck: boolean; hasLint: boolean }) {
  const want: [string, string][] = [["repo.search", "locate the implementation (fs_list / fs_read)"], ["unit_tests", "local behaviour (engine runs npm test)"]];
  if (c.familiarity.value !== "known" || c.category.value === "debugging") want.push(["static_index", "imports/routes/tests of the changed files (code index)"]);
  if (ctx.hasTypecheck) want.push(["typecheck", "contract consistency"]);
  if (ctx.hasLint) want.push(["lint", "project conventions"]);
  if (c.dependents.value > 0 || c.verificationDepth.value !== "targeted") want.push(["dependency_graph", "select regression tests from the system graph"]);
  if (ctx.ui) want.push(["browser", "real UI journeys in Chromium"]);
  if (c.risk.value !== "LOW") want.push(["security_review", "risk class present"]);
  if (c.research.value) want.push(["docs.research", "current external API documentation"]);
  return want.map(([tool, why]) => ({ tool, why, available: ctx.available[tool] ?? true, permitted: ["unit_tests", "typecheck", "lint", "dependency_graph", "static_index", "browser", "security_review"].includes(tool) ? true : ctx.permitted.includes(tool) }));
}

// ---------------------------------------------------------------------------
// Model routing with restrictions
// ---------------------------------------------------------------------------

export interface ModelCandidate { provider: string; model: string; tier: "FAST" | "STANDARD" | "REASONING"; available: boolean; supportsTools: boolean; contextTokens: number; dataRegions?: string[] }
export interface ModelPolicy {
  /** Approved providers for this project's data. Empty = any configured provider. */
  allowedProviders: string[];
  /** Pinned model ids (honoured even if the router would prefer another). */
  pinnedModels: string[];
  /** On unavailability: "fallback" to another approved candidate, or "fail" (keep state, report). */
  fallback: "fallback" | "fail";
}
export const DEFAULT_MODEL_POLICY: ModelPolicy = { allowedProviders: [], pinnedModels: [], fallback: "fallback" };

export function routeModel(want: { tier: "FAST" | "STANDARD" | "REASONING"; needsTools: boolean; contextTokens: number }, candidates: ModelCandidate[], policy: ModelPolicy) {
  const reasons: string[] = [];
  const approved = candidates.filter((c) => !policy.allowedProviders.length || policy.allowedProviders.includes(c.provider));
  if (approved.length < candidates.length) reasons.push(`${candidates.length - approved.length} candidate(s) excluded: provider not approved for this project's data`);
  const capable = approved.filter((c) => (!want.needsTools || c.supportsTools) && c.contextTokens >= want.contextTokens);
  const pinned = policy.pinnedModels.length ? capable.filter((c) => policy.pinnedModels.includes(c.model)) : capable;
  if (policy.pinnedModels.length && !pinned.length) return { chosen: null, fallbackUsed: false, reasons: [...reasons, `pinned model(s) ${policy.pinnedModels.join(", ")} not configured/capable`], blocker: "pinned model unavailable" };
  const order = (c: ModelCandidate) => (c.tier === want.tier ? 0 : ({ FAST: 0, STANDARD: 1, REASONING: 2 }[c.tier] > { FAST: 0, STANDARD: 1, REASONING: 2 }[want.tier] ? 1 : 2));
  const ranked = [...pinned].sort((a, b) => order(a) - order(b));
  const first = ranked[0];
  if (!first) return { chosen: null, fallbackUsed: false, reasons: [...reasons, "no approved provider supports the task's tool/context needs"], blocker: "no compatible provider" };
  if (first.available) return { chosen: first, fallbackUsed: false, reasons: [...reasons, `${first.provider}:${first.model} (${first.tier}) available`], blocker: null };
  if (policy.fallback === "fail") return { chosen: null, fallbackUsed: false, reasons: [...reasons, `${first.model} unavailable and the policy forbids fallback`], blocker: "preferred model unavailable" };
  // Fallback: same or stronger tier only — never silently downgrade below what the task asked for.
  const alt = ranked.find((c) => c.available && order(c) <= 1);
  if (!alt) return { chosen: null, fallbackUsed: false, reasons: [...reasons, "no available approved fallback at the required tier or above"], blocker: "no available provider" };
  return { chosen: alt, fallbackUsed: true, reasons: [...reasons, `${first.model} unavailable → fallback ${alt.provider}:${alt.model} (${alt.tier}), approved provider`], blocker: null };
}

// ---------------------------------------------------------------------------
// Feedback controller
// ---------------------------------------------------------------------------

export interface Signals {
  attempt: number;
  maxAttempts: number;
  adjustmentsSoFar: string[]; // action history (bounded; oscillation detection)
  recurringDefect: boolean; // same signature in consecutive attempts
  identicalTree: boolean; // repair changed nothing
  revertedFiles: string[]; // files changed then restored to base
  scopeGrowth: number; // changed files / planned files
  unprovenCriteria: number;
  reviewerConflict: boolean;
  categories: string[]; // defect categories of the last attempt
  budgetLeftUsd: number;
}
export type Adjustment = "continue" | "investigate" | "escalate_model" | "narrow_scope" | "add_reviewer" | "add_reproduction" | "retry_environment" | "stop";
export interface AdjustDecision { action: Adjustment; blocker: string; rationale: string; source: "plan" | "context" | "tool" | "environment" | "implementation" | "requirement" | "budget" }

export const MAX_ADJUSTMENTS = 3;

export function adjust(s: Signals): AdjustDecision {
  if (s.budgetLeftUsd <= 0) return { action: "stop", blocker: "budget exhausted", rationale: "no budget left for another attempt; state is kept for resume", source: "budget" };
  if (s.categories.some((c) => c === "infrastructure" || c === "permissions")) return { action: "retry_environment", blocker: "sandbox/infrastructure failure", rationale: "not a code defect: retry the environment, change nothing in code", source: "environment" };
  const adjustments = s.adjustmentsSoFar.filter((a) => a !== "continue");
  // Oscillation: the same adjustment twice in a row, or too many adjustments → stop and surface.
  const last2 = adjustments.slice(-2);
  if (adjustments.length >= MAX_ADJUSTMENTS) return { action: "stop", blocker: "adjustment budget used", rationale: `${adjustments.length} strategy changes (${adjustments.join(" → ")}) did not produce a passing attempt`, source: "plan" };
  if (s.identicalTree) return pick("investigate", "repair changed nothing", "the last repair did not change the code; gather new evidence (re-read failing tests and code) before another attempt", "implementation");
  if (s.revertedFiles.length) return pick("narrow_scope", `files changed then reverted: ${s.revertedFiles.slice(0, 3).join(", ")}`, "the agent is oscillating on the same files; narrow to the failing criterion and the planned files", "plan");
  if (s.scopeGrowth > 3) return pick("narrow_scope", `scope grew ${s.scopeGrowth.toFixed(1)}× the planned files`, "changes spread far beyond the plan; restrict to planned files + their tests", "plan");
  if (s.reviewerConflict) return pick("add_reviewer", "reviewers disagree", "evidence decides: add the independent reviewer's verdict and re-review on executed output", "implementation");
  if (s.recurringDefect) {
    if (!adjustments.includes("add_reproduction") && s.categories.includes("code")) return pick("add_reproduction", "same failure survived a repair", "pin the failure with a minimal reproducing test before changing code again", "implementation");
    return pick("escalate_model", "same failure survived a repair", "reasoning tier for a fresh root-cause analysis (once)", "implementation");
  }
  if (s.unprovenCriteria > 0 && s.attempt >= 1) return pick("investigate", `${s.unprovenCriteria} criterion(s) still unproven`, "criteria are not evidenced by tests; read how each criterion can be exercised through the real API", "context");
  return { action: "continue", blocker: "", rationale: "category-specific repair (orchestrator.recoveryFor)", source: "implementation" };

  function pick(action: Adjustment, blocker: string, rationale: string, source: AdjustDecision["source"]): AdjustDecision {
    if (last2.length === 2 && last2.every((a) => a === action)) return { action: "stop", blocker, rationale: `${action} already tried twice in a row without progress (oscillation)`, source };
    if (action === "escalate_model" && adjustments.includes("escalate_model")) return { action: "stop", blocker, rationale: "already escalated once; the failure persists — needs a person", source };
    return { action, blocker, rationale, source };
  }
}

// ---------------------------------------------------------------------------
// Collaboration value
// ---------------------------------------------------------------------------

/** Is splitting into parallel parts worth it? Requires disjoint files, few shared contracts and enough work. */
export function collaborationValue(parts: { key: string; files: string[]; dependsOn: string[] }[]) {
  if (parts.length < 2) return { worth: false, why: "single part" };
  const seen = new Map<string, string>();
  const overlaps: string[] = [];
  for (const p of parts) for (const f of p.files) { const o = seen.get(f); if (o && o !== p.key) overlaps.push(`${f} (${o}, ${p.key})`); seen.set(f, p.key); }
  const coupled = parts.filter((p) => p.dependsOn.some((d) => parts.some((q) => q.key === d)));
  if (overlaps.length) return { worth: false, why: `shared files: ${overlaps.slice(0, 3).join("; ")} — sequential is safer` };
  if (coupled.length) return { worth: false, why: `${coupled.map((c) => c.key).join(", ")} depend on sibling parts — sequential` };
  if (parts.reduce((s, p) => s + p.files.length, 0) < 3) return { worth: false, why: "too little work to amortise coordination" };
  return { worth: true, why: `${parts.length} independent parts, disjoint files` };
}

// ---------------------------------------------------------------------------
// Versioned policies (immutable; promoted by evidence, rolled back by id)
// ---------------------------------------------------------------------------

export interface AdaptivePolicy { id: string; description: string; adaptive: boolean; maxAdjustments: number }
export const ADAPTIVE_POLICIES: Record<string, AdaptivePolicy> = {
  baseline: { id: "baseline", description: "Pre-V16 behaviour: one strategy for every task (implement → verify → review → category repair).", adaptive: false, maxAdjustments: 0 },
  "adaptive-v1": { id: "adaptive-v1", description: "Classification → least-complex sufficient strategy, risk-based verification, feedback controller with bounded adjustments.", adaptive: true, maxAdjustments: MAX_ADJUSTMENTS },
};
export const DEFAULT_ADAPTIVE_POLICY = "adaptive-v1";
