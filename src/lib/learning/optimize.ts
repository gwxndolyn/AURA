/**
 * Controlled optimization loop (AURA V11 §7). Reuses the existing machinery —
 * no parallel system:
 *
 *   prompts   intelligence/experiments.ts (same dataset, repetitions, release
 *             gates, PromptPromotion audit, rollbackVersion)
 *   methods   lab/lab.ts (versioned benchmark suite, train/held-out, decide()
 *             incl. per-category regression rejection)
 *
 * This module adds the parts that were missing:
 *
 *   problems()        specific, evidence-backed performance problems from
 *                     FailureAttribution + RunOutcome (agent-scope only;
 *                     infrastructure/provider failures are never a prompt problem)
 *   proposePromptFix  a BOUNDED prompt change for one problem: the active
 *                     prompt + one targeted rule, created as a DRAFT version
 *                     (never ACTIVE) with the expected improvement and the
 *                     regressions to watch recorded in the changelog
 *   evaluateCandidate runs the existing A/B experiment (≥ 3 repetitions for
 *                     live models; simulation results are labelled as such and
 *                     can never satisfy promotion on their own)
 *
 * Promotion stays with promoteVersion (fresh regression run + gates) and an
 * ADMIN. Rollback stays one call away. Nothing here edits a prompt in place.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { aiMode } from "@/lib/ai/claude";
import { createVersion, agentPromptKey, getActiveVersion, ensureBuiltinPrompts } from "@/lib/intelligence/registry";
import { runExperiment } from "@/lib/intelligence/experiments";
import { emit } from "./service";

/** One targeted rule per attribution category (bounded, reviewable changes — not rewrites). */
export const FIX_RULES: Record<string, string> = {
  repository_assumption: "Before importing or calling anything, confirm it exists: fs_list the directory and fs_read the module. Never import a path you have not seen in the repository.",
  code_generation: "After writing code, run the focused tests, read the first failing assertion, and fix the code under test before finishing. Do not finish with failing tests.",
  inadequate_tests: "For every acceptance criterion write at least one falsifiable test that would fail without your change; name it after the criterion.",
  architecture_contract: "After every create/update/delete, re-fetch from the API and re-render; the UI must never show state the API did not return.",
  context_insufficient: "Read the files that import the module you change (dependents) and keep their contract; stay within the task's planned files.",
  security_defect: "For every new input path, validate type and size server-side and check ownership/authorization before reading or writing data.",
};

export interface Problem { agentKey: string; category: string; failures: number; runs: number; rate: number; evidence: { buildId: string; itemKey: string; rootCause: string }[]; promptRefs: string[] }

/** Evidence-backed problems: agent-scope attribution categories recurring across ≥ minRuns distinct runs. */
export async function problems(companyId: string, opts: { minRuns?: number; since?: Date } = {}) {
  const minRuns = opts.minRuns ?? 2;
  const attrs = await prisma.failureAttribution.findMany({ where: { companyId, scope: "agent", status: "ESTABLISHED", ...(opts.since ? { createdAt: { gte: opts.since } } : {}) }, select: { agentKey: true, category: true, buildId: true, itemKey: true, rootCause: true, promptRef: true } });
  const outcomes = await prisma.runOutcome.findMany({ where: { companyId, outcome: { in: ["VERIFIED", "FAILED", "BLOCKED"] } }, select: { ownerAgent: true } });
  const groups = new Map<string, typeof attrs>();
  for (const a of attrs) if (a.agentKey) groups.set(`${a.agentKey}|${a.category}`, [...(groups.get(`${a.agentKey}|${a.category}`) ?? []), a]);
  const out: Problem[] = [];
  for (const [k, xs] of groups) {
    const [agentKey, category] = k.split("|");
    const builds = [...new Set(xs.map((x) => x.buildId))];
    if (builds.length < minRuns) continue; // a single bad run is not a pattern
    const runs = outcomes.filter((o) => o.ownerAgent === agentKey).length;
    out.push({ agentKey, category, failures: builds.length, runs, rate: runs ? builds.length / runs : 0, evidence: xs.slice(0, 5).map((x) => ({ buildId: x.buildId, itemKey: x.itemKey, rootCause: x.rootCause })), promptRefs: [...new Set(xs.map((x) => x.promptRef).filter(Boolean) as string[])] });
  }
  return out.sort((a, b) => b.failures - a.failures);
}

/** Create a DRAFT candidate prompt = active prompt + one targeted rule. Idempotent per (agent, category, base version). */
export async function proposePromptFix(companyId: string, agentKey: string, category: string, actor: string) {
  const rule = FIX_RULES[category];
  if (!rule) throw new ApiError(`No bounded prompt change is defined for ${category}; it is not a prompt problem (or needs a workflow change)`, 422);
  await ensureBuiltinPrompts(companyId);
  const key = agentPromptKey(agentKey);
  const active = await getActiveVersion(companyId, key);
  if (!active) throw new ApiError("No active prompt version for this agent", 404);
  const marker = `## Learned rule (${category})`;
  if (active.content.includes(marker)) throw new ApiError("The active prompt already contains this rule", 409);
  const content = `${active.content}\n\n${marker}\n${rule}`;
  const existing = await prisma.promptVersion.findFirst({ where: { companyId, template: { key }, content } });
  if (existing) return existing;
  const p = (await problems(companyId)).find((x) => x.agentKey === agentKey && x.category === category);
  const v = await createVersion({ companyId, templateKey: key, content, author: `learning:${actor}`, changelog: `Bounded change from failure attribution: ${category} for ${agentKey} (${p ? `${p.failures} failing run(s): ${p.evidence.map((e) => e.itemKey).join(", ")}` : "manual"}). Expected: fewer ${category} attributions and higher first-pass success. Watch for: higher cost/latency, regressions on other dataset cases. Base v${active.version}.` });
  return v;
}

/**
 * Evaluate a candidate against the active baseline with the existing A/B
 * harness. With a simulated provider the result is recorded but flagged:
 * simulator output cannot demonstrate a prompt improvement.
 */
export async function evaluateCandidate(companyId: string, agentKey: string, candidateVersionId: string, actor: string, repetitions?: number) {
  const key = agentPromptKey(agentKey);
  const active = await getActiveVersion(companyId, key);
  if (!active) throw new ApiError("No active prompt version", 404);
  const live = aiMode() === "live";
  const exp = await runExperiment({ companyId, templateKey: key, baselineVersionId: active.id, candidateVersionId, repetitions: repetitions ?? (live ? 3 : 1), createdBy: actor });
  await emit({ companyId, type: "benchmark.completed", key: `prompt-exp:${(exp as { experimentId?: string }).experimentId ?? candidateVersionId}`, payload: { agentKey, candidateVersionId, live } });
  return { ...exp, mode: live ? "live" : "simulation", note: live ? null : "Simulated provider: this measures the harness, not the model — not evidence of a prompt improvement." };
}
