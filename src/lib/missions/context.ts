/**
 * Context assembly for mission agents.
 *
 * Deterministic, inspectable selection: each agent capability declares which
 * context kinds a task needs (capabilities.ts → requiredContext). We gather
 * candidate sources from persisted mission state + the fixture repository,
 * order them by priority, and fit them into the agent's token budget.
 *
 *   - Required sources are never silently dropped. If they don't fit, we
 *     truncate only sources marked `truncatable` and record it; if it still
 *     doesn't fit, assembly fails with `context_overflow` (no model call).
 *   - Optional sources (history) are omitted first, with a recorded note.
 *   - Every included source is recorded as provenance on the task run.
 *
 * No vector DB: the codebase is a small fixture; selection is by file scope,
 * dependency edges and artifact kind.
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { capabilityFor, type ContextKind } from "@/lib/agents/capabilities";
import { HandoffSchema, type Handoff } from "@/lib/agents/contracts";
import { repoFor } from "./repos";

export interface ContextSource {
  id: string;
  kind: ContextKind;
  ref: string; // file path, artifact id, handoff id…
  text: string;
  required: boolean;
  truncatable: boolean;
  priority: number; // lower = included first
}

export interface Provenance {
  id: string;
  kind: ContextKind;
  ref: string;
  tokens: number;
  required: boolean;
  included: boolean;
  truncated: boolean;
}

export interface AssembledContext {
  text: string;
  tokens: number;
  budget: number;
  sources: Provenance[];
  notes: string[];
  missingRequired: ContextKind[];
  handoffs: Handoff[];
}

export class ContextOverflowError extends Error {
  constructor(public detail: string) {
    super(`Required context does not fit the budget: ${detail}`);
    this.name = "ContextOverflowError";
  }
}

export class MissingContextError extends Error {
  constructor(public kinds: string[]) {
    super(`Required context is missing: ${kinds.join(", ")}`);
    this.name = "MissingContextError";
  }
}

/** Same estimator the simulator path uses (chars/4); labelled as an estimate in the UI. */
export const estimateTokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

type Mission = NonNullable<Awaited<ReturnType<typeof prisma.mission.findFirst>>>;
type Task = NonNullable<Awaited<ReturnType<typeof prisma.missionTask.findFirst>>>;

/**
 * Pure fitting step (unit-tested). Includes sources in priority order; drops
 * optional ones that don't fit; truncates truncatable required sources as a
 * last resort; throws if required content still can't fit.
 */
export function fitToBudget(sources: ContextSource[], budget: number): { included: { s: ContextSource; text: string; truncated: boolean }[]; provenance: Provenance[]; notes: string[] } {
  const ordered = [...sources].sort((a, b) => Number(b.required) - Number(a.required) || a.priority - b.priority);
  const requiredTokens = ordered.filter((s) => s.required).reduce((n, s) => n + estimateTokens(s.text), 0);
  const notes: string[] = [];
  let remaining = budget;
  const included: { s: ContextSource; text: string; truncated: boolean }[] = [];
  const provenance: Provenance[] = [];

  // If required alone exceeds budget, shrink truncatable required sources proportionally.
  let shrink = 1;
  if (requiredTokens > budget) {
    const fixed = ordered.filter((s) => s.required && !s.truncatable).reduce((n, s) => n + estimateTokens(s.text), 0);
    const flexible = requiredTokens - fixed;
    if (fixed > budget || flexible === 0) {
      throw new ContextOverflowError(`${requiredTokens} required tokens (${fixed} non-truncatable) vs budget ${budget}`);
    }
    shrink = Math.max(0, (budget - fixed) / flexible);
    if (shrink < 0.25) throw new ContextOverflowError(`required sources would be cut to ${Math.round(shrink * 100)}% — split the task instead`);
  }

  for (const s of ordered) {
    const t = estimateTokens(s.text);
    if (s.required) {
      let text = s.text;
      let truncated = false;
      if (shrink < 1 && s.truncatable) {
        const keep = Math.floor(s.text.length * shrink);
        text = `${s.text.slice(0, keep)}\n…[truncated ${s.text.length - keep} chars to fit budget]`;
        truncated = true;
        notes.push(`Truncated required ${s.kind} source ${s.ref} to ${Math.round(shrink * 100)}%`);
      }
      const used = estimateTokens(text);
      remaining -= used;
      included.push({ s, text, truncated });
      provenance.push({ id: s.id, kind: s.kind, ref: s.ref, tokens: used, required: true, included: true, truncated });
    } else if (t <= remaining) {
      remaining -= t;
      included.push({ s, text: s.text, truncated: false });
      provenance.push({ id: s.id, kind: s.kind, ref: s.ref, tokens: t, required: false, included: true, truncated: false });
    } else {
      provenance.push({ id: s.id, kind: s.kind, ref: s.ref, tokens: t, required: false, included: false, truncated: false });
      notes.push(`Omitted optional ${s.kind} source ${s.ref} (${t} tokens; ${Math.max(0, remaining)} left)`);
    }
  }
  return { included, provenance, notes };
}

const HEADINGS: Record<ContextKind, string> = {
  objective: "Mission objective",
  acceptance: "Acceptance criteria",
  plan: "Plan",
  task: "Your task",
  handoffs: "Handoffs from dependencies (validated)",
  conventions: "Project conventions",
  code: "Code",
  tests: "Tests",
  "test-results": "Latest test evidence (system-recorded)",
  findings: "Open findings you must address",
  security: "Security constraints",
  attempts: "Previous attempts",
};

/** Gather candidate sources for a task from persisted state. */
async function gather(m: Mission, t: Task, needed: Set<ContextKind>): Promise<{ sources: ContextSource[]; handoffs: Handoff[] }> {
  const repo = repoFor(m.template);
  const sources: ContextSource[] = [];
  const add = (s: Omit<ContextSource, "required">) => sources.push({ ...s, required: needed.has(s.kind) });
  const writeScope = parseJSON<string[]>(t.files, []);
  const deps = parseJSON<string[]>(t.dependsOn, []);

  add({ id: "objective", kind: "objective", ref: `mission:${m.id}`, text: m.objective, truncatable: false, priority: 0 });
  const acceptance = parseJSON<string[]>(m.acceptance, []);
  if (acceptance.length) add({ id: "acceptance", kind: "acceptance", ref: `mission:${m.id}#acceptance`, text: acceptance.map((a) => `- ${a}`).join("\n"), truncatable: false, priority: 1 });
  const plan = await prisma.missionPlan.findFirst({ where: { missionId: m.id, version: m.planVersion } });
  if (plan) add({ id: `plan:${plan.version}`, kind: "plan", ref: `plan:v${plan.version}`, text: plan.summary, truncatable: true, priority: 8 });
  add({
    id: `task:${t.key}`,
    kind: "task",
    ref: `task:${t.key}`,
    text: [
      `${t.title} (${t.kind})`,
      t.description,
      `Acceptance: ${parseJSON<string[]>(t.acceptance, []).join("; ")}`,
      writeScope.length ? `Write scope (enforced): ${writeScope.join(", ")}` : "Write scope: none (read-only task)",
      // Reviewers can only raise checkable concerns: list the executable probes.
      t.kind === "REVIEW" && repoFor(m.template) ? `Executable probes (a concern must name one to be checkable):\n${repoFor(m.template)!.probes.map((p) => `- ${p.id}: ${p.description}`).join("\n")}` : "",
    ].filter(Boolean).join("\n"),
    truncatable: false,
    priority: 0,
  });

  // Handoffs from direct dependencies only (not the whole history), latest valid per dependency.
  const handoffs: Handoff[] = [];
  for (const d of deps) {
    const h = await prisma.missionHandoff.findFirst({ where: { missionId: m.id, planVersion: m.planVersion, fromTaskKey: d, valid: true }, orderBy: { createdAt: "desc" } });
    if (!h) continue;
    const parsed = HandoffSchema.safeParse(parseJSON(h.payload, {}));
    if (!parsed.success) continue;
    handoffs.push(parsed.data);
    const p = parsed.data;
    add({
      id: `handoff:${h.id}`,
      kind: "handoffs",
      ref: `handoff:${d}`,
      text: [
        `From ${p.fromAgent} (${p.taskKind} "${p.taskKey}"): ${p.objective}`,
        p.findings.length ? `Findings: ${p.findings.join(" | ")}` : "",
        p.decisions.length ? `Decisions: ${p.decisions.join(" | ")}` : "",
        p.tests.length ? `Tests (system-recorded): ${p.tests.map((x) => `${x.passed}/${x.total} passed (${x.mode})${x.failing.length ? ` failing: ${x.failing.join("; ")}` : ""}`).join(" | ")}` : "",
        p.outstandingIssues.length ? `Outstanding: ${p.outstandingIssues.map((i) => `${i.code} ${i.severity}${i.blocking ? " blocking" : ""}: ${i.title}`).join(" | ")}` : "",
        `Next: ${p.nextAction}`,
      ].filter(Boolean).join("\n"),
      truncatable: true,
      priority: 2,
    });
  }

  if (repo) {
    add({ id: `conventions:${repo.id}`, kind: "conventions", ref: `${repo.id}/CONVENTIONS`, text: repo.conventions, truncatable: true, priority: 6 });
    add({ id: `security:${repo.id}`, kind: "security", ref: `${repo.id}/SECURITY`, text: repo.security, truncatable: false, priority: 3 });
    // Code: the task's write scope first, then files named by dependency handoffs (architect's affected files).
    const named = new Set<string>(writeScope);
    for (const h of handoffs) for (const f of (h.output.affectedFiles as string[] | undefined) ?? []) named.add(f);
    if (!named.size) for (const f of repo.sourceFiles) named.add(f);
    const current = await currentFiles(m.id, repo);
    for (const f of named) {
      if (!(f in current)) continue;
      add({ id: `code:${f}`, kind: "code", ref: f, text: `// ${f}\n${current[f]}`, truncatable: true, priority: 4 });
    }
    for (const f of repo.testFiles) add({ id: `tests:${f}`, kind: "tests", ref: f, text: `// ${f}\n${repo.files[f]}`, truncatable: true, priority: 5 });
  }

  const lastTest = await prisma.missionArtifact.findFirst({ where: { missionId: m.id, kind: "TEST_REPORT" }, orderBy: { createdAt: "desc" } });
  if (lastTest) {
    const meta = parseJSON<{ mode?: string; passed?: number; total?: number; cases?: { name: string; ok: boolean }[] }>(lastTest.meta, {});
    add({
      id: `artifact:${lastTest.id}`,
      kind: "test-results",
      ref: `artifact:${lastTest.id}`,
      text: `${lastTest.name}: ${meta.passed}/${meta.total} passed (${meta.mode})\n${(meta.cases ?? []).map((c) => `${c.ok ? "ok" : "FAIL"} ${c.name}`).join("\n")}`,
      truncatable: true,
      priority: 3,
    });
  }

  const open = await prisma.missionFinding.findMany({ where: { missionId: m.id, status: "OPEN", blocking: true }, orderBy: { createdAt: "asc" } });
  if (open.length) {
    add({
      id: "findings",
      kind: "findings",
      ref: open.map((f) => f.code).join(","),
      text: open.map((f) => `${f.code} [${f.severity}] ${f.title}\n${f.description}\nEvidence: ${f.evidence}\nRecommendation: ${f.recommendation}`).join("\n\n"),
      truncatable: false,
      priority: 1,
    });
  }

  const prior = await prisma.missionTaskRun.findMany({ where: { missionId: m.id, taskKey: t.key, status: { not: "RUNNING" } }, orderBy: { startedAt: "asc" } });
  if (prior.length) {
    add({
      id: `attempts:${t.key}`,
      kind: "attempts",
      ref: prior.map((r) => r.id).join(","),
      text: prior.map((r) => `Attempt ${r.attempt}: ${r.status}${r.errorCategory ? ` (${r.errorCategory})` : ""}${r.error ? ` — ${r.error.slice(0, 200)}` : ""}`).join("\n"),
      truncatable: true,
      priority: 7,
    });
  }
  return { sources, handoffs };
}

/**
 * Latest content of each fixture file in this mission's working copy: the
 * newest FILE artifact, else the mission's base snapshot (when it works on a
 * project workspace), else the fixture's original content.
 */
export async function currentFiles(missionId: string, repo: NonNullable<ReturnType<typeof repoFor>>): Promise<Record<string, string>> {
  const m = await prisma.mission.findUnique({ where: { id: missionId }, select: { baseFiles: true } });
  const base = parseJSON<Record<string, string>>(m?.baseFiles, {});
  const out: Record<string, string> = {};
  for (const f of [...repo.sourceFiles, ...repo.testFiles]) {
    const latest = await prisma.missionArtifact.findFirst({ where: { missionId, kind: "FILE", name: f }, orderBy: { version: "desc" } });
    out[f] = latest?.content ?? base[f] ?? repo.files[f];
  }
  return out;
}

/** Assemble the context for one task execution under its agent's budget. */
export async function assembleContext(m: Mission, t: Task, opts: { budgetTokens?: number } = {}): Promise<AssembledContext> {
  const cap = capabilityFor(t.agentKey);
  const neededList = cap?.requiredContext[t.kind] ?? ["objective", "task"];
  const needed = new Set<ContextKind>(neededList);
  const budget = opts.budgetTokens ?? cap?.maxContextTokens ?? 8000;
  const { sources, handoffs } = await gather(m, t, needed);

  // Required kinds that produced no source at all.
  const present = new Set(sources.map((s) => s.kind));
  // Situational kinds (may legitimately be empty) and repo-backed kinds when the mission has no codebase.
  const situational = ["findings", "attempts", "test-results", "handoffs", ...(repoFor(m.template) ? [] : ["code", "tests", "conventions", "security"])];
  const missingRequired = [...needed].filter((k) => !present.has(k) && !situational.includes(k));
  // Handoffs are required when the task has dependencies; a missing one is a handoff failure, not optional.
  const deps = parseJSON<string[]>(t.dependsOn, []);
  if (needed.has("handoffs") && deps.length && handoffs.length < deps.length) missingRequired.push("handoffs");

  const fit = fitToBudget(sources, budget);
  const byKind = new Map<ContextKind, string[]>();
  for (const { s, text } of fit.included) byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), text]);
  const order: ContextKind[] = ["objective", "acceptance", "task", "findings", "handoffs", "test-results", "security", "code", "tests", "conventions", "plan", "attempts"];
  const text = order
    .filter((k) => byKind.has(k))
    .map((k) => `# ${HEADINGS[k]}\n${byKind.get(k)!.join("\n\n")}`)
    .join("\n\n");
  return { text, tokens: estimateTokens(text), budget, sources: fit.provenance, notes: fit.notes, missingRequired, handoffs };
}
