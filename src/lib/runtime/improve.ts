/**
 * One persistent self-improvement cycle (job type `lab.cycle`, and the body
 * of `improve_aura` goals). Built on the engineering lab (src/lib/lab):
 *
 *   evaluate  run the suite on the active configuration (Docker executor)
 *   select    take the evidence-ranked backlog; pick the highest-risk item
 *             that has a registered CANDIDATE METHOD (a versioned config
 *             variant already in the code) whose approach key was not
 *             rejected before without new evidence
 *   experiment  propose + run it (baseline = active config); the lab's
 *             decision rules accept / reject / hold for approval
 *   record    persist; update the backlog and loop state; schedule nothing
 *             itself (recurrence is a Schedule)
 *
 * Limits: at most AURA_IMPROVE_MAX_CYCLES_PER_DAY cycles per workspace per
 * UTC day; an approach key is attempted at most once per suite version; the
 * lab never edits code — code-level candidates go through selfmod.ts
 * (isolated worktree + Docker-run tests + branch, never merged).
 *
 * Nothing here can change benchmark definitions, decision rules, security
 * methods' approval requirement, or the AURA permissions — those files are
 * outside what the cycle touches.
 */
import { prisma } from "@/lib/db";
import { JobError } from "@/lib/jobs/queue";
import { runSuite, proposeBacklog, proposeExperiment, runExperiment, loadState, verifyState } from "@/lib/lab/lab";
import { SUITE_VERSION } from "@/lib/lab/benchmarks";
import { GATE_POLICIES, DEFAULT_GATE_POLICY } from "@/lib/builder/verdict";
import { CONTEXT_STRATEGIES, DEFAULT_CONTEXT_STRATEGY } from "@/lib/builder/intel";
import { CLASSIFIER_VERSIONS, DEFAULT_CLASSIFIER } from "@/lib/builder/debug";
import { resolveConfig } from "@/lib/lab/config";

export const IMPROVE_LIMITS = { maxCyclesPerDay: Number(process.env.AURA_IMPROVE_MAX_CYCLES_PER_DAY || 6) };

/** Candidate methods registered in code, mapped to the backlog keys (capabilities) they target. */
function candidatesFor(backlogKey: string, active: ReturnType<typeof resolveConfig>) {
  const out: { key: string; config: string; metric: string; title: string }[] = [];
  const latest = <T extends string>(xs: readonly T[]) => xs[xs.length - 1];
  if (backlogKey.startsWith("gate-false-")) {
    const v = latest(Object.keys(GATE_POLICIES));
    if (v !== active.gatePolicy) out.push({ key: `gate-${v}`, config: `gate=${v}`, metric: "engineeringQuality.badChangeRejection", title: `Gate ${v} against the active gate ${active.gatePolicy}` });
  }
  if (backlogKey.startsWith("context:")) {
    const v = latest(CONTEXT_STRATEGIES);
    if (v !== active.contextStrategy) out.push({ key: `context-${v}`, config: `context=${v}`, metric: "engineeringQuality.contextRecall", title: `Context ${v} against ${active.contextStrategy}` });
  }
  if (backlogKey.startsWith("diagnose:")) {
    const v = latest(CLASSIFIER_VERSIONS);
    if (v !== active.classifier) out.push({ key: `diagnose-${v}`, config: `diagnose=${v}`, metric: "autonomy.diagnosisCorrect", title: `Classifier ${v} against ${active.classifier}` });
  }
  return out;
}

export async function runImprovementCycle(companyId: string, opts: { actor: string; signal?: AbortSignal; goalId?: string }) {
  const steps: Record<string, string> = {};
  const dayStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const today = await prisma.labRun.count({ where: { companyId, label: "cycle-evaluate", startedAt: { gte: dayStart } } });
  if (today >= IMPROVE_LIMITS.maxCyclesPerDay) throw new JobError(`Improvement cycle limit reached (${IMPROVE_LIMITS.maxCyclesPerDay}/day)`, false, "budget");
  await verifyState(companyId);
  const st = await loadState(companyId);
  if (st.status === "PAUSED") return { steps: { evaluate: "loop paused" } as Record<string, string>, experimentId: null as string | null, summary: "The improvement loop is paused; nothing ran." };
  const active = resolveConfig(st.activeConfig);

  const evalRun = await runSuite({ companyId, configKey: st.activeConfig, split: "all", label: "cycle-evaluate", actor: opts.actor });
  steps.evaluate = `run ${evalRun.run.id}: ${evalRun.run.passed}/${evalRun.run.total} on ${evalRun.run.executor}, suite ${SUITE_VERSION}`;
  if (evalRun.run.executor !== "docker") return { steps, experimentId: null, summary: `${steps.evaluate}. Experiments need the Docker executor for adoptable evidence; none started.` };
  if (opts.signal?.aborted) throw new JobError("cancelled", false, "cancelled");

  const backlog = await proposeBacklog(companyId);
  const tried = await prisma.labExperiment.findMany({ where: { companyId }, select: { key: true, status: true, decision: true } });
  const exhausted = (key: string) => tried.some((t) => t.key === key && (t.status === "REJECTED" || ((t.status === "INCONCLUSIVE" || t.status === "AWAITING_APPROVAL" || t.status === "ACCEPTED") && t.decision.includes(SUITE_VERSION))));
  let chosen: { item: (typeof backlog.items)[number]; cand: ReturnType<typeof candidatesFor>[number] } | null = null;
  for (const item of backlog.items) {
    const c = candidatesFor(item.key, active).find((x) => !exhausted(x.key));
    if (c) { chosen = { item, cand: c }; break; }
  }
  steps.select = chosen ? `${chosen.item.key} (${chosen.item.risk}, ${chosen.item.evidence.length} failing case(s)) → candidate ${chosen.cand.config}` : `${backlog.items.length} backlog item(s); no untested registered candidate method for any of them (a new method must be written first)`;
  if (!chosen) return { steps, experimentId: null, summary: steps.select };

  const e = await proposeExperiment({
    companyId, actor: opts.actor, key: chosen.cand.key, title: chosen.cand.title,
    problem: `Backlog item ${chosen.item.key} (${chosen.item.risk}): ${chosen.item.evidence.length} failing benchmark case(s) on the active configuration ${st.activeConfig}.`,
    evidence: [{ kind: "lab_run", ref: evalRun.run.id, detail: steps.evaluate }, ...chosen.item.evidence.slice(0, 5)],
    hypothesis: `The registered candidate ${chosen.cand.config} improves ${chosen.cand.metric} without regressions.`,
    success: [{ metric: chosen.cand.metric, op: "delta>=", value: 0.05, split: "train" }, { metric: chosen.cand.metric, op: "delta>=", value: 0, split: "heldout" }],
    regression: [{ metric: "functional.correctAccepts", op: ">=", value: 1, split: "all" }, { metric: "economics.falseRejectRate", op: "<=", value: 0, split: "all" }, { metric: "reliability.harnessErrors", op: "<=", value: 0, split: "all" }],
    procedure: "Automated improvement cycle: full suite on the Docker executor, active config vs candidate.",
    rejectIf: "Any regression rule fails, a defective change is newly accepted, or held-out results drop.",
    baselineConfig: st.activeConfig, candidateConfig: mergeConfig(st.activeConfig, chosen.cand.config),
  });
  steps.experiment = `experiment ${e.id} (${e.key})`;
  const r = await runExperiment(companyId, e.id, opts.actor);
  steps.record = `${r.decision.outcome}: ${r.decision.reasons.slice(0, 3).join("; ")}`;
  return { steps, experimentId: e.id, summary: `Experiment ${e.key}: ${r.decision.outcome}. ${r.decision.reasons.slice(0, 2).join("; ")}` };
}

function mergeConfig(active: string, cand: string) {
  const parts = new Map<string, string>();
  for (const s of [active, cand]) if (s && s !== "default") for (const p of s.split(",")) { const [k, v] = p.split("="); parts.set(k, v); }
  const d = { gate: DEFAULT_GATE_POLICY, context: DEFAULT_CONTEXT_STRATEGY, diagnose: DEFAULT_CLASSIFIER } as Record<string, string>;
  const kept = [...parts.entries()].filter(([k, v]) => d[k] !== v);
  return kept.length ? kept.map(([k, v]) => `${k}=${v}`).join(",") : "default";
}
