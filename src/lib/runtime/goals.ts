/**
 * Autonomous goal engine. A Goal is driven by durable `goal.advance` jobs:
 * each job performs ONE bounded step from the goal's persisted checkpoint,
 * records evidence and usage, then enqueues the next advance (or stops). A
 * worker crash, restart or deploy between steps loses nothing — the next
 * advance resumes from the checkpoint. There is no in-memory loop.
 *
 * It reuses AURA's engines instead of adding a parallel one:
 *   build_product / add_feature  → product factory (planning job, scope
 *     approval, scheduler ticks dispatching real builder runs in the Docker
 *     sandbox, evidence-only VERIFIED, delivery gate)
 *   improve_aura                 → engineering lab cycle (src/lib/runtime/improve.ts)
 *   continue_product             → resumes an existing product's backlog
 *
 * "Attempted" vs "completed": a goal is COMPLETED only when its acceptance
 * criteria are met by recorded evidence (gate criteria / verified tasks /
 * accepted experiments). Otherwise it ends FAILED, BLOCKED (needs a person,
 * with the reason) or BUDGET_EXHAUSTED — never "done".
 *
 * Modes (enforced here, server side):
 *   SUPERVISED              scope approval and every consequential action wait for a person
 *   AUTONOMOUS_DEV          AURA approves the PLANNING scope it drafted, builds/tests/commits to
 *                           isolated branches; publishing/deploying still needs a person
 *   CONTINUOUS_IMPROVEMENT  only improve_aura goals; results are proposals for review
 *   PRODUCTION_OPS          monitoring + explicitly allow-listed reversible actions; nothing else
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { parseJSON } from "@/lib/utils";
import { audit, emitEvent } from "@/lib/events/emit";
import { enqueue, cancel as cancelJob, JobError } from "@/lib/jobs/queue";
import { createProduct, loadProduct } from "@/lib/factory/store";
import { tickProduct, controlProduct } from "@/lib/factory/scheduler";
import { decideProductApproval } from "@/lib/factory/release";
import { evaluateGate } from "@/lib/factory/gate";
import { productDetail } from "@/lib/factory/read";
import { runImprovementCycle } from "./improve";
import { log } from "@/lib/observability/log";

export const GOAL_KINDS = ["build_product", "add_feature", "improve_aura", "continue_product"] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];
export const GOAL_MODES = ["SUPERVISED", "AUTONOMOUS_DEV", "CONTINUOUS_IMPROVEMENT", "PRODUCTION_OPS"] as const;
export type GoalMode = (typeof GOAL_MODES)[number];
export const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "BUDGET_EXHAUSTED"];

export interface GoalLimits {
  maxAdvances: number; // engine steps (each is one durable job)
  maxWallMs: number; // total wall time since start
  maxCostUsd: number; // estimated model spend (provider-reported tokens × list price)
  maxModelCalls: number;
  maxConsecutiveFailures: number; // failed steps in a row → BLOCKED (circuit)
  pollMs: number; // wait between advances while work runs elsewhere (builds, approvals)
}
export const DEFAULT_GOAL_LIMITS: GoalLimits = { maxAdvances: 200, maxWallMs: 6 * 3600_000, maxCostUsd: 10, maxModelCalls: 400, maxConsecutiveFailures: 3, pollMs: 15_000 };
const BOUNDS: Record<keyof GoalLimits, [number, number]> = { maxAdvances: [1, 2000], maxWallMs: [60_000, 7 * 86_400_000], maxCostUsd: [0.01, 500], maxModelCalls: [1, 10_000], maxConsecutiveFailures: [1, 20], pollMs: [100, 3_600_000] };
export function clampGoalLimits(l: Partial<GoalLimits>): GoalLimits {
  const out = { ...DEFAULT_GOAL_LIMITS };
  for (const k of Object.keys(BOUNDS) as (keyof GoalLimits)[]) if (typeof l[k] === "number" && Number.isFinite(l[k])) out[k] = Math.min(Math.max(l[k] as number, BOUNDS[k][0]), BOUNDS[k][1]);
  return out;
}

const MODE_KINDS: Record<GoalMode, GoalKind[]> = {
  SUPERVISED: ["build_product", "add_feature", "continue_product", "improve_aura"],
  AUTONOMOUS_DEV: ["build_product", "add_feature", "continue_product", "improve_aura"],
  CONTINUOUS_IMPROVEMENT: ["improve_aura"],
  PRODUCTION_OPS: [],
};
/** Minimum workspace role per mode (checked by the API before createGoal). */
export const MODE_ROLE: Record<GoalMode, "MEMBER" | "ADMIN" | "OWNER"> = { SUPERVISED: "MEMBER", AUTONOMOUS_DEV: "ADMIN", CONTINUOUS_IMPROVEMENT: "ADMIN", PRODUCTION_OPS: "OWNER" };

type GoalRow = NonNullable<Awaited<ReturnType<typeof prisma.goal.findFirst>>>;
interface Step { key: string; title: string; status: "pending" | "running" | "done" | "failed" | "waiting" | "skipped"; evidence?: string; at?: string }
interface Checkpoint { step: string; productId?: string; consecutiveFailures?: number; startedAt?: string; experimentIds?: string[]; lastTick?: unknown }
interface Usage { advances: number; modelCalls: number; tokensIn: number; tokensOut: number; costUsd: number; costSource: string; wallMs: number }

const PLANS: Record<GoalKind, Step[]> = {
  build_product: [
    { key: "plan", title: "PM drafts brief, acceptance criteria and dependency-aware backlog (model)", status: "pending" },
    { key: "scope", title: "Scope approval", status: "pending" },
    { key: "build", title: "Agents implement, the engine verifies in the sandbox, bounded repairs", status: "pending" },
    { key: "verify", title: "Delivery gate evaluated from evidence", status: "pending" },
  ],
  add_feature: [],
  continue_product: [
    { key: "build", title: "Resume the product's backlog", status: "pending" },
    { key: "verify", title: "Delivery gate evaluated from evidence", status: "pending" },
  ],
  improve_aura: [
    { key: "evaluate", title: "Run the benchmark suite on the active configuration", status: "pending" },
    { key: "select", title: "Pick the highest-risk backlog item with an untested candidate", status: "pending" },
    { key: "experiment", title: "Run the experiment (baseline vs candidate, same suite + executor)", status: "pending" },
    { key: "record", title: "Record the decision and update the improvement backlog", status: "pending" },
  ],
};
PLANS.add_feature = PLANS.build_product;

export async function createGoal(input: { companyId: string; userId: string; email: string; kind: GoalKind; mode: GoalMode; request: string; title?: string; productId?: string; limits?: Partial<GoalLimits> }) {
  if (!GOAL_KINDS.includes(input.kind)) throw new ApiError("Unknown goal kind", 422);
  if (!GOAL_MODES.includes(input.mode)) throw new ApiError("Unknown mode", 422);
  if (!MODE_KINDS[input.mode].includes(input.kind)) throw new ApiError(input.mode === "PRODUCTION_OPS" ? "Production operations mode runs only explicitly authorized operational actions; no goal kinds are enabled for it yet" : `${input.kind} goals are not allowed in ${input.mode} mode`, 422);
  if (input.kind === "continue_product") {
    if (!input.productId) throw new ApiError("continue_product needs productId", 422);
    await loadProduct(input.companyId, input.productId);
  }
  const request = input.request.trim();
  if (input.kind !== "continue_product" && input.kind !== "improve_aura" && request.length < 20) throw new ApiError("Describe the goal in at least 20 characters", 422);
  const g = await prisma.goal.create({
    data: {
      companyId: input.companyId, kind: input.kind, mode: input.mode, title: (input.title || request.split(/[.\n]/)[0] || input.kind).slice(0, 120), request: request.slice(0, 4000),
      productId: input.productId ?? null, plan: JSON.stringify(PLANS[input.kind]), limits: JSON.stringify(clampGoalLimits(input.limits ?? {})),
      usage: JSON.stringify({ advances: 0, modelCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, costSource: "none yet", wallMs: 0 } satisfies Usage),
      checkpoint: JSON.stringify({ step: PLANS[input.kind][0].key } satisfies Checkpoint), createdBy: input.userId, createdByEmail: input.email,
    },
  });
  await audit(input.companyId, input.email, "GOAL_CREATED", g.id, `${g.kind} (${g.mode})`);
  await scheduleAdvance(g, 0);
  return g;
}

/** Enqueue the next advance. Dedupe per (goal, advance number) so duplicate deliveries never run a step twice. */
export async function scheduleAdvance(g: { id: string; companyId: string; usage: string; limits: string }, delayMs: number) {
  const u = parseJSON<Usage>(g.usage, { advances: 0 } as Usage);
  const job = await enqueue({ companyId: g.companyId, type: "goal.advance", payload: { goalId: g.id }, dedupeKey: `goal:${g.id}:${u.advances}`, runAt: new Date(Date.now() + delayMs), goalId: g.id, maxAttempts: 3, createdBy: `goal:${g.id}`, concurrencyKey: `goal:${g.id}`, timeoutMs: 20 * 60_000 });
  await prisma.goal.update({ where: { id: g.id }, data: { currentJobId: job.id, nextCheckAt: job.runAt } });
  return job;
}

async function usageFor(g: GoalRow, cp: Checkpoint): Promise<Usage> {
  const prev = parseJSON<Usage>(g.usage, { advances: 0, modelCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, costSource: "", wallMs: 0 });
  const started = cp.startedAt ? new Date(cp.startedAt).getTime() : g.createdAt.getTime();
  const productId = cp.productId ?? g.productId;
  if (!productId) return { ...prev, wallMs: Date.now() - started };
  // Measured from persisted runs: provider-reported tokens × list price (an ESTIMATE; labelled).
  const b = await prisma.build.aggregate({ where: { companyId: g.companyId, productId, createdAt: { gte: g.createdAt } }, _sum: { costUsd: true, tokensIn: true, tokensOut: true, modelCalls: true } });
  const plan = await prisma.usageEvent.aggregate({ where: { companyId: g.companyId, source: `product:${productId}:planning`, createdAt: { gte: g.createdAt }, metric: "ai_cost_usd" }, _sum: { quantity: true } });
  return { ...prev, modelCalls: b._sum.modelCalls ?? 0, tokensIn: b._sum.tokensIn ?? 0, tokensOut: b._sum.tokensOut ?? 0, costUsd: (b._sum.costUsd ?? 0) + (plan._sum.quantity ?? 0), costSource: "estimate: provider-reported tokens × list price", wallMs: Date.now() - started };
}

function setStep(plan: Step[], key: string, status: Step["status"], evidence?: string) {
  return plan.map((s) => (s.key === key ? { ...s, status, evidence: evidence?.slice(0, 600) ?? s.evidence, at: new Date().toISOString() } : s));
}

async function finish(g: GoalRow, status: string, reason: string, data: Record<string, unknown> = {}) {
  const r = await prisma.goal.updateMany({ where: { id: g.id, status: { notIn: TERMINAL } }, data: { status, statusReason: reason.slice(0, 1000), finishedAt: TERMINAL.includes(status) ? new Date() : null, currentJobId: null, nextCheckAt: null, ...data } });
  if (r.count) {
    await emitEvent({ companyId: g.companyId, type: "PRODUCT_UPDATED", level: status === "COMPLETED" ? "success" : status === "WAITING" ? "info" : "warning", message: `Goal "${g.title}": ${status.toLowerCase().replace("_", " ")} — ${reason.slice(0, 200)}`, meta: { goalId: g.id } }).catch(() => null);
    if (["FAILED", "BLOCKED", "BUDGET_EXHAUSTED"].includes(status)) {
      await prisma.notification.upsert({ where: { companyId_dedupeKey: { companyId: g.companyId, dedupeKey: `goal:${g.id}:${status}` } }, create: { companyId: g.companyId, dedupeKey: `goal:${g.id}:${status}`, kind: status === "BUDGET_EXHAUSTED" ? "budget" : "intervention", severity: "high", title: `Goal ${status.toLowerCase().replace("_", " ")}: ${g.title}`.slice(0, 200), body: reason.slice(0, 400), href: `/autopilot?goal=${g.id}` }, update: { body: reason.slice(0, 400) } }).catch(() => null);
    }
  }
}

/**
 * One engine step for a goal (the `goal.advance` job body). Idempotent: if
 * the goal is terminal, paused or the job is a stale duplicate, it does nothing.
 */
export async function advanceGoal(goalId: string, ctx: { signal?: AbortSignal; jobId?: string } = {}) {
  const g = await prisma.goal.findUnique({ where: { id: goalId } });
  if (!g) throw new JobError("Goal not found", false, "missing");
  if (TERMINAL.includes(g.status) || g.status === "PAUSED") return { status: g.status, note: "nothing to do" };
  if (ctx.jobId && g.currentJobId && g.currentJobId !== ctx.jobId) return { status: g.status, note: "superseded advance" };
  const limits = clampGoalLimits(parseJSON<Partial<GoalLimits>>(g.limits, {}));
  const cp = parseJSON<Checkpoint>(g.checkpoint, { step: "plan" });
  if (!cp.startedAt) cp.startedAt = new Date().toISOString();
  let plan = parseJSON<Step[]>(g.plan, []);
  const usage = await usageFor(g, cp);
  usage.advances += 1;
  const persist = async (data: Record<string, unknown>) => prisma.goal.update({ where: { id: g.id }, data: { usage: JSON.stringify(usage), checkpoint: JSON.stringify(cp), plan: JSON.stringify(plan), ...data } });

  // Budget enforcement BEFORE doing work.
  const over = usage.advances > limits.maxAdvances ? `step limit (${limits.maxAdvances})` : usage.wallMs > limits.maxWallMs ? `time limit (${Math.round(limits.maxWallMs / 60_000)} min)` : usage.costUsd >= limits.maxCostUsd ? `cost limit ($${limits.maxCostUsd}; ${usage.costSource})` : usage.modelCalls >= limits.maxModelCalls ? `model-call limit (${limits.maxModelCalls})` : null;
  if (over) {
    if (cp.productId) await controlProduct(g.companyId, cp.productId, "pause", "goal-engine").catch(() => null);
    await persist({});
    await finish(g, "BUDGET_EXHAUSTED", `Stopped: ${over} reached. State is saved at step "${cp.step}"; an authorized person can raise the limits and resume.`);
    return { status: "BUDGET_EXHAUSTED" };
  }
  await prisma.goal.update({ where: { id: g.id }, data: { status: "RUNNING", statusReason: "" } });

  try {
    const r = g.kind === "improve_aura" ? await stepImprove(g, cp, plan, ctx) : await stepProduct(g, cp, plan, limits);
    plan = r.plan;
    cp.consecutiveFailures = 0;
    await persist({ acceptance: r.acceptance ? JSON.stringify(r.acceptance) : undefined, productId: cp.productId ?? g.productId });
    if (r.terminal) {
      await finish(g, r.terminal, r.reason);
      return { status: r.terminal };
    }
    if (r.waiting) await prisma.goal.update({ where: { id: g.id }, data: { status: "WAITING", statusReason: r.reason.slice(0, 1000) } });
    await scheduleAdvance({ ...g, usage: JSON.stringify(usage) }, r.delayMs ?? limits.pollMs);
    return { status: r.waiting ? "WAITING" : "RUNNING", step: cp.step };
  } catch (e) {
    cp.consecutiveFailures = (cp.consecutiveFailures ?? 0) + 1;
    plan = setStep(plan, cp.step, "failed", (e as Error).message);
    await persist({});
    log("warn", "goal.step_failed", { goalId: g.id, step: cp.step, error: (e as Error).message.slice(0, 300), consecutive: cp.consecutiveFailures });
    if (cp.consecutiveFailures >= limits.maxConsecutiveFailures) {
      await finish(g, "BLOCKED", `Step "${cp.step}" failed ${cp.consecutiveFailures} times in a row: ${(e as Error).message.slice(0, 400)}. Fix the cause and resume.`);
      return { status: "BLOCKED" };
    }
    // Provider/sandbox outages: back off and retry the same step (state is checkpointed).
    await scheduleAdvance({ ...g, usage: JSON.stringify(usage) }, Math.min(limits.pollMs * 2 ** cp.consecutiveFailures, 15 * 60_000));
    return { status: "RUNNING", retrying: true };
  }
}

interface StepResult { plan: Step[]; terminal?: string; waiting?: boolean; reason: string; delayMs?: number; acceptance?: { id: string; text: string; status: string; evidence: string }[] }

async function stepProduct(g: GoalRow, cp: Checkpoint, plan: Step[], limits: GoalLimits): Promise<StepResult> {
  if (cp.step === "plan") {
    if (!cp.productId && g.kind !== "continue_product") {
      const created = await createProduct({ companyId: g.companyId, userId: g.createdBy, actor: g.createdByEmail || "goal-engine", idea: g.request, autonomy: g.mode === "AUTONOMOUS_DEV" ? "BOUNDED" : "SUPERVISED" });
      cp.productId = created.product.id;
      return { plan: setStep(plan, "plan", "running", `product ${created.product.id}; planning job ${created.jobId}`), reason: "planning job queued", delayMs: 1000 };
    }
    const p = await loadProduct(g.companyId, cp.productId!);
    if (p.planningStatus === "FAILED") return { plan: setStep(plan, "plan", "failed", p.planningError), terminal: "BLOCKED", reason: `Planning failed: ${p.planningError}. Retry planning on the product, then resume the goal.` };
    if (p.planningStatus !== "READY") return { plan, waiting: true, reason: `waiting for the planning job (${p.planningStatus.toLowerCase()})` };
    const d = await productDetail(g.companyId, p.id);
    cp.step = "scope";
    return { plan: setStep(plan, "plan", "done", `brief v${d.brief?.version}; ${d.items.filter((i) => i.level === "TASK").length} task(s); acceptance ${(d.brief?.content as { acceptance?: unknown[] })?.acceptance?.length ?? 0}`), reason: "planned", delayMs: 0, acceptance: acceptanceOf(d) };
  }
  if (cp.step === "scope") {
    const p = await loadProduct(g.companyId, cp.productId!);
    if (!p.scopeApproved) {
      const pending = (await productDetail(g.companyId, p.id)).approvals.find((a) => a.action === "scope" && a.status === "PENDING");
      if (pending && g.mode === "AUTONOMOUS_DEV") {
        // Analysis-class approval of AURA's own plan; publication/production approvals are never auto-granted.
        await decideProductApproval(g.companyId, p.id, pending.id, `goal-engine (autonomous mode, on behalf of ${g.createdByEmail})`, "approve", "auto-approved: AUTONOMOUS_DEV mode allows AURA to proceed with its own plan inside the isolated workspace");
      } else return { plan: setStep(plan, "scope", "waiting", "scope approval pending"), waiting: true, reason: "waiting for a person to approve the scope (supervised mode)" };
    }
    cp.step = "build";
    return { plan: setStep(plan, "scope", "done", "scope approved"), reason: "scope approved", delayMs: 0 };
  }
  if (cp.step === "build") {
    const t = await tickProduct(g.companyId, cp.productId!, { actor: "goal-engine" });
    cp.lastTick = { dispatched: t.dispatched, settled: t.settled, blocked: t.blocked, waitingOn: t.waitingOn.slice(0, 10), note: t.note };
    const d = await productDetail(g.companyId, cp.productId!);
    const tasks = d.items.filter((i) => (i.level === "TASK" || i.level === "REPAIR") && i.status !== "CANCELLED");
    const open = tasks.filter((t) => !["VERIFIED", "DONE_UNVERIFIED", "FAILED", "BLOCKED"].includes(t.status));
    const blocked = tasks.filter((t) => t.status === "BLOCKED");
    const progress = `${d.overview.progress.verified}/${d.overview.progress.executable} executable task(s) verified`;
    if (open.length === 0) {
      cp.step = "verify";
      return { plan: setStep(plan, "build", blocked.length ? "failed" : "done", `${progress}${blocked.length ? `; blocked: ${blocked.map((b) => b.key).join(", ")}` : ""}`), reason: "backlog settled", delayMs: 0, acceptance: acceptanceOf(d) };
    }
    if (t.note && /paused|cancelled/i.test(t.note)) return { plan, terminal: "BLOCKED", reason: t.note };
    const needsPerson = t.waitingOn.filter((w) => /approval|autonomy is SUGGEST/.test(w));
    return { plan: setStep(plan, "build", "running", progress), waiting: needsPerson.length > 0 && !t.dispatched.length, reason: needsPerson.length ? `waiting: ${needsPerson.join("; ")}` : `${progress}; ${t.waitingOn.length ? t.waitingOn.slice(0, 3).join("; ") : `dispatched ${t.dispatched.join(", ") || "nothing new"}`}`, delayMs: limits.pollMs, acceptance: acceptanceOf(d) };
  }
  if (cp.step === "verify") {
    const gate = await evaluateGate(g.companyId, cp.productId!);
    const d = await productDetail(g.companyId, cp.productId!);
    const acc = acceptanceOf(d);
    const tasks = d.items.filter((i) => (i.level === "TASK" || i.level === "REPAIR") && i.executable && i.status !== "CANCELLED");
    const allVerified = tasks.length > 0 && tasks.every((t) => t.status === "VERIFIED");
    const failedCrit = gate.criteria.filter((c) => c.required && c.status === "failed").map((c) => c.label);
    const ev = `gate ${gate.profile}: ${gate.summary.passed} passed, ${gate.summary.failed} failed, ${gate.summary.notVerified} not verified; open required: ${gate.summary.requiredOpen.join(", ") || "none"}`;
    if (!allVerified) {
      const blocked = d.items.filter((i) => i.status === "BLOCKED").map((i) => `${i.key}: ${i.blockedReason.slice(0, 120)}`);
      return { plan: setStep(plan, "verify", "failed", ev), terminal: blocked.length ? "BLOCKED" : "FAILED", reason: `Not every executable task was verified. ${blocked.length ? `Blocked: ${blocked.join(" | ")}` : ""} ${failedCrit.length ? `Failed criteria: ${failedCrit.join(", ")}` : ""}`.trim(), acceptance: acc };
    }
    // "Completed" for an autonomous build goal = every executable task verified by sandbox evidence AND the
    // goal's acceptance criteria traced to verified work; release/deploy remain separate human decisions.
    const reqCrit = gate.criteria.find((c) => c.id === "requirements");
    if (reqCrit && reqCrit.status !== "passed") return { plan: setStep(plan, "verify", "failed", ev), terminal: "FAILED", reason: `Tasks verified but requirements are not all traced to verified work: ${reqCrit.detail}`, acceptance: acc };
    return { plan: setStep(plan, "verify", "done", ev), terminal: "COMPLETED", reason: `All ${tasks.length} executable task(s) verified with sandbox evidence; requirements traced (${reqCrit?.detail ?? "n/a"}). Release candidate and deployment are separate approvals. ${ev}`, acceptance: acc };
  }
  throw new JobError(`Unknown step ${cp.step}`, false, "internal");
}

function acceptanceOf(d: Awaited<ReturnType<typeof productDetail>>) {
  const brief = d.brief?.content as { acceptance?: { id: string; text: string }[] } | undefined;
  const tasks = d.items.filter((i) => i.level === "TASK" || i.level === "REPAIR");
  return (brief?.acceptance ?? []).map((a) => {
    const impl = tasks.filter((t) => (t as unknown as { requirements?: string }).requirements?.includes?.(a.id) || JSON.stringify(t).includes(`"${a.id}"`));
    const met = impl.length > 0 && impl.every((t) => t.status === "VERIFIED");
    return { id: a.id, text: a.text, status: met ? "met" : impl.some((t) => t.status === "FAILED") ? "not_met" : "unverified", evidence: impl.length ? impl.map((t) => `${t.key} ${t.status.toLowerCase()}`).join(", ") : "no task implements it yet" };
  });
}

async function stepImprove(g: GoalRow, cp: Checkpoint, plan: Step[], ctx: { signal?: AbortSignal }): Promise<StepResult> {
  const r = await runImprovementCycle(g.companyId, { actor: g.createdByEmail || "goal-engine", signal: ctx.signal, goalId: g.id });
  plan = plan.map((s) => ({ ...s, status: "done" as const, evidence: r.steps[s.key] ?? s.evidence, at: new Date().toISOString() }));
  cp.step = "record";
  cp.experimentIds = [...(cp.experimentIds ?? []), ...(r.experimentId ? [r.experimentId] : [])];
  const acceptance = [{ id: "AC-1", text: "An evidence-backed experiment was run and decided (accepted / rejected / inconclusive / awaiting approval)", status: r.experimentId ? "met" : "unverified", evidence: r.summary }];
  if (!r.experimentId) return { plan, terminal: "COMPLETED", reason: `Cycle ran; no experiment was eligible: ${r.summary}`, acceptance };
  return { plan, terminal: "COMPLETED", reason: r.summary, acceptance };
}

// ---------------------------------------------------------------------------
// Controls (server-side authorization is done by the API layer)
// ---------------------------------------------------------------------------

export async function controlGoal(companyId: string, goalId: string, action: "pause" | "resume" | "cancel", actor: string, limits?: Partial<GoalLimits>) {
  const g = await prisma.goal.findFirst({ where: { id: goalId, companyId } });
  if (!g) throw new ApiError("Goal not found", 404);
  const cp = parseJSON<Checkpoint>(g.checkpoint, { step: "" });
  if (action === "pause") {
    if (TERMINAL.includes(g.status) || g.status === "PAUSED") throw new ApiError(`Goal is ${g.status.toLowerCase()}`, 409);
    await prisma.goal.update({ where: { id: g.id }, data: { status: "PAUSED", statusReason: `paused by ${actor}`, nextCheckAt: null } });
    if (g.currentJobId) await cancelJob(companyId, g.currentJobId);
    if (cp.productId) await controlProduct(companyId, cp.productId, "pause", actor).catch(() => null);
  } else if (action === "resume") {
    if (!["PAUSED", "BLOCKED", "BUDGET_EXHAUSTED", "FAILED"].includes(g.status)) throw new ApiError(`Goal is ${g.status.toLowerCase()}`, 409);
    const newLimits = limits ? clampGoalLimits({ ...parseJSON<Partial<GoalLimits>>(g.limits, {}), ...limits }) : clampGoalLimits(parseJSON(g.limits, {}));
    const u = parseJSON<Usage>(g.usage, { advances: 0 } as Usage);
    if (g.status === "BUDGET_EXHAUSTED" && !limits) throw new ApiError("The goal stopped at its budget; raise the limits to resume", 409);
    cp.consecutiveFailures = 0;
    const updated = await prisma.goal.update({ where: { id: g.id }, data: { status: "QUEUED", statusReason: `resumed by ${actor}`, finishedAt: null, limits: JSON.stringify(newLimits), checkpoint: JSON.stringify(cp) } });
    if (cp.productId) await controlProduct(companyId, cp.productId, "resume", actor).catch(() => null);
    await scheduleAdvance({ ...updated, usage: JSON.stringify(u) }, 0);
  } else {
    if (TERMINAL.includes(g.status)) throw new ApiError(`Goal is ${g.status.toLowerCase()}`, 409);
    await prisma.goal.update({ where: { id: g.id }, data: { status: "CANCELLED", statusReason: `cancelled by ${actor}`, finishedAt: new Date(), nextCheckAt: null } });
    if (g.currentJobId) await cancelJob(companyId, g.currentJobId);
    if (cp.productId) await controlProduct(companyId, cp.productId, "cancel", actor).catch(() => null);
  }
  await audit(companyId, actor, "GOAL_CONTROL", g.id, action);
  return prisma.goal.findUnique({ where: { id: g.id } });
}
