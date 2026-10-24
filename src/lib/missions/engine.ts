/**
 * Mission execution engine.
 *
 * Execution model (serverless-safe, no background timers):
 *   `advanceMission(missionId)` performs ONE bounded unit of work — claims at
 *   most one eligible task with a lease (and the file locks its write scope
 *   needs), executes one attempt via executor.ts, applies the outcome, and
 *   returns. Callers (the "advance" route or a client loop) call it
 *   repeatedly. A crash mid-task leaves an expired lease, which the next call
 *   reclaims (the abandoned run is recorded as ABANDONED).
 *
 * Collaboration is explicit and persisted:
 *   - each attempt is a MissionTaskRun with context provenance + usage
 *   - outputs are validated against per-kind contracts and handed off
 *   - QA failures and evidence-backed review findings open a bounded repair
 *     round: the implementing task and everything downstream re-run
 *
 * Nothing is marked passed without a recorded result.
 */
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/events/emit";
import { runAgent } from "@/lib/agents/orchestrator";
import { parseJSON } from "@/lib/utils";
import { TERMINAL_MISSION, type MissionStatus } from "./state";
import { eligible, blockedByFailure, descendants } from "./graph";
import { engineeringPlan, genericPlan, templateFor, validatePlan, AssignmentError, type Plan } from "./planner";
import { repoFor } from "./repos";
import { currentFiles } from "./context";
import { executeTaskRun } from "./executor";
import { requestEvaluation } from "@/lib/ops/monitor";
import { MissionError, event, setMissionStatus, setTaskStatus, accrue, hashFiles, releaseLocks, type Mission, type Task } from "./store";

export { MissionError };
export const LEASE_MS = 90_000;

/** Seeded sample missions are a read-only baseline; reset restores them. */
function assertMutable(m: Mission) {
  if (m.source === "SEEDED") throw new MissionError("Sample missions are read-only. Run the example mission to try this yourself.", 409);
}

/** Hash of the mission's current working copy (what was tested/reviewed/approved). */
async function currentHash(m: Mission): Promise<string> {
  const repo = repoFor(m.template);
  if (!repo) return createHash("sha256").update("").digest("hex");
  return hashFiles(await currentFiles(m.id, repo), repo.sourceFiles);
}

// ---------------------------------------------------------------------------
// Create + plan
// ---------------------------------------------------------------------------

export async function createMission(args: { companyId: string; createdById: string; objective: string; title?: string; source?: "USER" | "EXAMPLE"; budgetUsd?: number; risk?: "LOW" | "MEDIUM" | "HIGH"; maxRepairs?: number; toolTimeouts?: Record<string, number>; template?: string }) {
  const objective = args.objective.trim();
  if (objective.length < 10) throw new MissionError("Describe the objective in at least 10 characters", 422);
  // An explicit template must name a real executable fixture; otherwise infer from the objective.
  if (args.template && !repoFor(args.template)) throw new MissionError(`Unknown executable template ${args.template}`, 422);
  const template = args.template ?? templateFor(objective);
  const m = await prisma.mission.create({
    data: {
      companyId: args.companyId,
      createdById: args.createdById,
      title: (args.title ?? objective).slice(0, 90),
      objective: objective.slice(0, 2000),
      template,
      source: args.source ?? "USER",
      budgetUsd: Math.min(Math.max(args.budgetUsd ?? 1, 0.0001), 10),
      risk: args.risk ?? (template === "checkout-fix" ? "HIGH" : "LOW"),
      maxRepairs: Math.min(Math.max(args.maxRepairs ?? 2, 0), 5),
      // Overrides can only tighten a tool's timeout (10 ms … 60 s).
      toolTimeouts: JSON.stringify(Object.fromEntries(Object.entries(args.toolTimeouts ?? {}).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, Math.min(Math.max(Math.round(v), 10), 60_000)]))),
    },
  });
  await audit(args.companyId, args.createdById, "MISSION_CREATED", m.id, m.title);
  await event(args.companyId, m.id, `Mission created: ${m.title}`, "info", undefined, { analytics: "mission_created", source: m.source });
  return m;
}

/** Generate (or regenerate) a plan version. Previous versions are kept and marked SUPERSEDED. */
export async function planMission(missionId: string, companyId: string, opts: { reason?: string; override?: Plan } = {}) {
  const m = await prisma.mission.findFirst({ where: { id: missionId, companyId } });
  if (!m) throw new MissionError("Mission not found", 404);
  assertMutable(m);
  if (TERMINAL_MISSION.includes(m.status as MissionStatus) || ["RUNNING", "PAUSED", "READY"].includes(m.status)) {
    throw new MissionError(`Cannot replan a ${m.status.toLowerCase()} mission`, 409);
  }
  if (m.status === "DRAFT" || m.status === "AWAITING_APPROVAL") await setMissionStatus(m, "PLANNING");

  let plan: Plan;
  try {
    if (opts.override) plan = opts.override;
    else if (m.template) {
      plan = engineeringPlan(m.template, { risk: m.risk as "LOW" | "MEDIUM" | "HIGH", maxRepairs: m.maxRepairs });
      // The PM still runs a real (or simulated) planning turn so the plan has an attributable author.
      const run = await runAgent({ companyId, agentKey: "product-manager", objective: `Plan mission: ${m.objective}`, kind: "summary", context: repoFor(m.template)!.ticket });
      await accrue(m.id, { cost: run.cost, modelCalls: 1 });
    } else {
      const run = await runAgent({ companyId, agentKey: "product-manager", objective: `Plan mission: ${m.objective}`, kind: "summary" });
      await accrue(m.id, { cost: run.cost, modelCalls: 1 });
      plan = genericPlan(m.objective, run.text);
    }
  } catch (e) {
    if (e instanceof AssignmentError) {
      await setMissionStatus(m, "FAILED", e.message);
      throw new MissionError(e.message, 422);
    }
    throw e;
  }

  const v = validatePlan(plan);
  if (!v.ok) {
    await setMissionStatus(m, "FAILED", `Plan rejected by validation: ${v.errors.join("; ")}`);
    throw new MissionError(`Plan failed validation: ${v.errors.join("; ")}`, 422);
  }

  const version = m.planVersion + 1;
  await prisma.$transaction([
    prisma.missionPlan.updateMany({ where: { missionId: m.id, status: "PROPOSED" }, data: { status: "SUPERSEDED" } }),
    prisma.missionPlan.create({
      data: {
        missionId: m.id,
        companyId,
        version,
        summary: plan.summary,
        risks: JSON.stringify(plan.risks),
        estimatedMinutes: plan.estimatedMinutes,
        estimatedCostUsd: plan.tasks.reduce((s, t) => s + t.budgetUsd, 0),
        requiresApproval: true,
        changeReason: opts.reason ?? (version === 1 ? "initial plan" : "replanned"),
      },
    }),
    prisma.missionTask.deleteMany({ where: { missionId: m.id, status: "PENDING" } }),
    ...plan.tasks.map((t) =>
      prisma.missionTask.create({
        data: {
          missionId: m.id,
          companyId,
          planVersion: version,
          key: t.key,
          title: t.title,
          description: t.description,
          kind: t.kind,
          agentKey: t.agentKey,
          assignmentReason: t.assignmentReason,
          domain: t.domain,
          files: JSON.stringify(t.files),
          budgetUsd: t.budgetUsd,
          tools: JSON.stringify(t.tools),
          dependsOn: JSON.stringify(t.dependsOn),
          acceptance: JSON.stringify(t.acceptance),
          required: t.required,
          maxAttempts: t.maxAttempts,
        },
      }),
    ),
    prisma.mission.update({ where: { id: m.id }, data: { planVersion: version, acceptance: JSON.stringify(plan.acceptance), risk: plan.risk, maxRepairs: plan.maxRepairs } }),
  ]);
  await setMissionStatus(m, "AWAITING_APPROVAL", "Plan ready for review");
  await event(companyId, m.id, `Plan v${version} proposed: ${plan.tasks.length} tasks, awaiting approval`, "info", "product-manager", { analytics: "plan_generated" });
  return { version, plan };
}

/** Human decision on the current plan. Only a human (route-level authz) can call this. */
export async function decidePlan(missionId: string, companyId: string, decision: "approve" | "reject", actor: string, note = "") {
  const m = await prisma.mission.findFirst({ where: { id: missionId, companyId } });
  if (!m) throw new MissionError("Mission not found", 404);
  assertMutable(m);
  if (m.status !== "AWAITING_APPROVAL") throw new MissionError(`Mission is ${m.status.toLowerCase()}, not awaiting plan approval`, 409);
  const plan = await prisma.missionPlan.findFirst({ where: { missionId, version: m.planVersion, status: "PROPOSED" } });
  if (!plan) throw new MissionError("No proposed plan to decide on", 409);
  await prisma.missionPlan.update({ where: { id: plan.id }, data: { status: decision === "approve" ? "APPROVED" : "REJECTED", decidedBy: actor, decidedAt: new Date(), changeReason: note || plan.changeReason } });
  await audit(companyId, actor, decision === "approve" ? "MISSION_PLAN_APPROVED" : "MISSION_PLAN_REJECTED", m.id, `plan v${plan.version}${note ? `: ${note}` : ""}`);
  if (decision === "approve") {
    await setMissionStatus(m, "READY", `Plan v${plan.version} approved`);
    await event(companyId, m.id, `Plan v${plan.version} approved by operator`, "success", undefined, { analytics: "plan_approved" });
  } else {
    await setMissionStatus(m, "CANCELLED", `Plan v${plan.version} rejected${note ? `: ${note}` : ""}`, { completedAt: new Date() });
    await prisma.missionTask.updateMany({ where: { missionId, status: "PENDING" }, data: { status: "SKIPPED", output: "Plan rejected" } });
    await event(companyId, m.id, `Plan v${plan.version} rejected`, "warning");
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface AdvanceResult {
  status: string;
  progressed: boolean;
  task?: { key: string; status: string };
  waitingOn?: string;
  note?: string;
}

/**
 * Acquire file locks for a task's write scope. All-or-nothing; a lock held by
 * another task (unexpired) blocks the claim. Expired locks are stolen.
 */
async function acquireLocks(m: Mission, t: Task, owner: string): Promise<boolean> {
  const paths = parseJSON<string[]>(t.files, []);
  if (!paths.length) return true;
  const now = new Date();
  await prisma.missionLock.deleteMany({ where: { missionId: m.id, path: { in: paths }, expiresAt: { lt: now } } });
  try {
    await prisma.$transaction(paths.map((path) => prisma.missionLock.create({ data: { missionId: m.id, companyId: m.companyId, path, taskKey: t.key, owner, expiresAt: new Date(now.getTime() + LEASE_MS) } })));
    return true;
  } catch {
    return false; // unique (missionId, path) violated → another task holds it
  }
}

/** Pick the first READY task whose write scope is free; returns it with locks held. */
async function claimNext(m: Mission, worker: string): Promise<Task | null | "locked"> {
  const ready = await prisma.missionTask.findMany({ where: { missionId: m.id, planVersion: m.planVersion, status: "READY" }, orderBy: { createdAt: "asc" } });
  if (!ready.length) return null;
  let blocked = false;
  for (const c of ready) {
    if (!(await acquireLocks(m, c, worker))) {
      blocked = true;
      continue;
    }
    const claimed = await prisma.missionTask.updateMany({
      where: { id: c.id, status: "READY" },
      data: { status: "RUNNING", leaseOwner: worker, leaseExpiresAt: new Date(Date.now() + LEASE_MS), startedAt: c.startedAt ?? new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count === 1) return (await prisma.missionTask.findUnique({ where: { id: c.id } }))!;
    await releaseLocks(m.id, c.key);
  }
  return blocked ? "locked" : null;
}

/**
 * Perform one bounded step. Idempotent with respect to concurrent callers:
 * a task is only executed by the caller that wins its lease.
 */
export async function advanceMission(missionId: string, companyId: string, worker: string = randomUUID()): Promise<AdvanceResult> {
  const m = await prisma.mission.findFirst({ where: { id: missionId, companyId } });
  if (!m) throw new MissionError("Mission not found", 404);
  assertMutable(m);
  if (TERMINAL_MISSION.includes(m.status as MissionStatus)) return { status: m.status, progressed: false, note: "Mission is finished" };
  if (m.status === "DRAFT" || m.status === "PLANNING" || m.status === "AWAITING_APPROVAL") {
    return { status: m.status, progressed: false, waitingOn: "plan approval" };
  }
  if (m.status === "PAUSED") return { status: m.status, progressed: false, waitingOn: m.operatorHold ? "operator hold" : "approval gate" };

  if (m.status === "READY") {
    // Concurrent callers race this transition; the loser simply continues as RUNNING.
    const won = await prisma.mission.updateMany({ where: { id: m.id, status: "READY" }, data: { status: "RUNNING", statusReason: "Execution started", startedAt: new Date() } });
    m.status = "RUNNING";
    if (won.count === 1) {
      await audit(companyId, "mission-engine", "MISSION_STATUS", m.id, "READY → RUNNING: Execution started");
      await event(companyId, m.id, "Execution started", "info");
    }
  }

  // Deadline + budget hard stops (checked before every step; the executor re-checks before every model call).
  if (m.deadline && m.deadline.getTime() < Date.now()) {
    await finish(m, "FAILED", "Mission deadline passed");
    return { status: "FAILED", progressed: true, note: "deadline" };
  }
  if (m.costUsd >= m.budgetUsd) {
    await finish(m, "FAILED", `Mission budget exhausted ($${m.costUsd.toFixed(4)} of $${m.budgetUsd}); remaining tasks were not run`);
    return { status: "FAILED", progressed: true, note: "budget" };
  }

  const tasks = await prisma.missionTask.findMany({ where: { missionId, planVersion: m.planVersion }, orderBy: { createdAt: "asc" } });
  const graph = tasks.map((t) => ({ key: t.key, dependsOn: parseJSON<string[]>(t.dependsOn, []), status: t.status, required: t.required }));

  // Propagate failures: anything downstream of a failed task can never run.
  const doomed = blockedByFailure(graph);
  if (doomed.length) {
    await prisma.missionTask.updateMany({ where: { missionId, planVersion: m.planVersion, key: { in: doomed } }, data: { status: "SKIPPED", output: "Skipped: an upstream dependency failed" } });
    for (const k of doomed) graph.find((g) => g.key === k)!.status = "SKIPPED";
  }

  // Recover tasks whose worker died (expired lease) — they are retried, not lost; the dead attempt is recorded.
  const stale = tasks.filter((t) => t.status === "RUNNING" && t.leaseExpiresAt && t.leaseExpiresAt.getTime() < Date.now());
  for (const s of stale) {
    const rec = await prisma.missionTask.updateMany({ where: { id: s.id, status: "RUNNING", leaseExpiresAt: s.leaseExpiresAt }, data: { status: "READY", leaseOwner: null, leaseExpiresAt: null, output: `${s.output}\nRecovered after an interrupted run.`.trim() } });
    if (rec.count === 1) {
      await prisma.missionTaskRun.updateMany({ where: { missionId, taskKey: s.key, status: "RUNNING" }, data: { status: "ABANDONED", errorCategory: "worker_lost", error: "Lease expired before the attempt finished (worker crashed or restarted)", completedAt: new Date() } });
      await releaseLocks(missionId, s.key);
      await event(companyId, m.id, `Recovered interrupted task "${s.title}"`, "warning");
    }
  }

  const waiting = tasks.find((t) => t.status === "WAITING_APPROVAL");
  if (waiting) {
    await setMissionStatus(m, "PAUSED", `Waiting for approval: ${waiting.title}`);
    return { status: "PAUSED", progressed: true, waitingOn: waiting.title };
  }

  // Mark eligible tasks READY.
  const ready = eligible(graph);
  if (ready.length) await prisma.missionTask.updateMany({ where: { missionId, planVersion: m.planVersion, key: { in: ready }, status: "PENDING" }, data: { status: "READY" } });

  const task = await claimNext(m, worker);
  if (task === "locked") return { status: m.status, progressed: false, note: "waiting for a file lock held by another task" };
  if (!task) {
    const fresh = await prisma.missionTask.findMany({ where: { missionId, planVersion: m.planVersion } });
    const running = fresh.some((t) => t.status === "RUNNING");
    if (running) return { status: m.status, progressed: false, note: "another worker is executing a task" };
    const failedRequired = fresh.filter((t) => t.required && (t.status === "FAILED" || t.status === "SKIPPED"));
    if (failedRequired.length) {
      await finish(m, "FAILED", `Required task did not succeed: ${failedRequired.map((t) => t.title).join(", ")}`);
      return { status: "FAILED", progressed: true };
    }
    if (fresh.every((t) => t.status === "SUCCEEDED" || (!t.required && t.status === "SKIPPED"))) {
      const blocking = await prisma.missionFinding.count({ where: { missionId, status: "OPEN", blocking: true } });
      if (blocking) {
        await finish(m, "FAILED", `${blocking} blocking finding(s) remain open`);
        return { status: "FAILED", progressed: true };
      }
      await finish(m, "COMPLETED", "All required tasks succeeded and no blocking finding is open");
      return { status: "COMPLETED", progressed: true };
    }
    return { status: m.status, progressed: false, note: "no eligible task" };
  }

  await event(companyId, m.id, `${task.agentKey} started: ${task.title}`, "info", task.agentKey, { taskKey: task.key });
  const { run, outcome } = await executeTaskRun(m, task, worker);
  await releaseLocks(m.id, task.key);

  // Cancellation while the step executed: record it, never resurrect the task.
  const now = await prisma.mission.findUnique({ where: { id: m.id }, select: { status: true } });
  if (now?.status === "CANCELLED") {
    await prisma.missionTaskRun.update({ where: { id: run.id }, data: { status: "CANCELLED", outcome: "cancelled" } });
    const cur = (await prisma.missionTask.findUnique({ where: { id: task.id } }))!;
    if (cur.status === "RUNNING") await setTaskStatus(cur, "SKIPPED", { output: `${cur.output}\nMission cancelled during execution; result discarded.`.trim(), leaseOwner: null, leaseExpiresAt: null });
    return { status: "CANCELLED", progressed: true, task: { key: task.key, status: "SKIPPED" }, note: "cancelled during execution" };
  }

  await applyOutcome(m, task, run.id, outcome);
  // Event-driven health evaluation (throttled by the monitor's interval; never blocks the mission).
  if (outcome.status !== "SUCCEEDED") await requestEvaluation(companyId);
  // Project missions: keep the review record of the agents' patch in step with verification.
  if (m.workspaceId && ["CODE_CHANGE", "TEST", "REVIEW"].includes(task.kind)) {
    // Lazy import: devspace/changes depends on this module (createMission/planMission).
    const { syncMissionChanges } = await import("@/lib/devspace/changes");
    await syncMissionChanges(companyId, m.id).catch(() => {});
  }
  const after = (await prisma.missionTask.findUnique({ where: { id: task.id } }))!;
  return { status: m.status, progressed: true, task: { key: after.key, status: after.status } };
}

function withHistory(t: Task, output: string) {
  return t.output ? `${t.output}\n${output}` : output;
}

async function applyOutcome(m: Mission, task: Task, runId: string, outcome: Awaited<ReturnType<typeof executeTaskRun>>["outcome"]) {
  const clear = { leaseOwner: null, leaseExpiresAt: null };
  switch (outcome.status) {
    case "SUCCEEDED":
      await setTaskStatus(task, "SUCCEEDED", { output: withHistory(task, outcome.summary), verification: outcome.verification, errorCategory: null, completedAt: new Date(), ...clear });
      await event(m.companyId, m.id, `${task.title}: ${outcome.summary}`, "success", task.agentKey, { taskKey: task.key, runId });
      return;
    case "WAITING_APPROVAL":
      await setTaskStatus(task, "WAITING_APPROVAL", { output: withHistory(task, outcome.summary), ...clear });
      return;
    case "FAILED":
      await setTaskStatus(task, "FAILED", { output: withHistory(task, `Failed: ${outcome.error}`), verification: outcome.verification ?? "FAILED", errorCategory: outcome.category, completedAt: new Date(), ...clear });
      await event(m.companyId, m.id, `${task.title} failed: ${outcome.error}`, "danger", task.agentKey, { taskKey: task.key, runId, category: outcome.category });
      return;
    case "REPAIR":
      return repairRound(m, task, runId, outcome);
  }
}

/**
 * Bounded repair: reopen the implementing task(s) upstream of the failing
 * verifier and everything downstream of them. Stops at mission.maxRepairs;
 * then the findings are marked UNRESOLVED and the mission fails.
 */
async function repairRound(m: Mission, task: Task, runId: string, outcome: Extract<Awaited<ReturnType<typeof executeTaskRun>>["outcome"], { status: "REPAIR" }>) {
  const tasks = await prisma.missionTask.findMany({ where: { missionId: m.id, planVersion: m.planVersion } });
  const graph = tasks.map((t) => ({ key: t.key, dependsOn: parseJSON<string[]>(t.dependsOn, []), status: t.status }));
  const ups = new Set<string>();
  const walk = (k: string) => {
    for (const d of graph.find((g) => g.key === k)?.dependsOn ?? []) {
      const dt = tasks.find((t) => t.key === d);
      if (dt?.kind === "CODE_CHANGE") ups.add(d);
      else walk(d);
    }
  };
  walk(task.key);
  const fresh = (await prisma.mission.findUnique({ where: { id: m.id } }))!;

  if (!ups.size || fresh.repairRounds >= fresh.maxRepairs) {
    const why = !ups.size ? "no implementing task upstream to repair" : `repair limit reached (${fresh.maxRepairs} round${fresh.maxRepairs === 1 ? "" : "s"})`;
    await prisma.missionFinding.updateMany({ where: { missionId: m.id, code: { in: outcome.findingCodes }, status: "OPEN" }, data: { status: "UNRESOLVED" } });
    await setTaskStatus(task, "FAILED", { output: withHistory(task, `${outcome.summary}. Not repaired: ${why}.`), verification: "FAILED", errorCategory: outcome.outcome === "tests_failed" ? "test_failure" : "review_rejected", completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null });
    await event(m.companyId, m.id, `${task.title}: ${outcome.reason}; ${why} — needs intervention`, "danger", task.agentKey, { taskKey: task.key, runId });
    return;
  }

  const reopen = new Set<string>([...ups, ...[...ups].flatMap((u) => descendants(graph, u))]);
  await setTaskStatus(task, "FAILED", { output: withHistory(task, `${outcome.summary}. Sent back for repair (round ${fresh.repairRounds + 1} of ${fresh.maxRepairs}).`), verification: "FAILED", errorCategory: outcome.outcome === "tests_failed" ? "test_failure" : "review_rejected", leaseOwner: null, leaseExpiresAt: null });
  for (const k of reopen) {
    const t = tasks.find((x) => x.key === k)!;
    const cur = k === task.key ? task : t;
    if (cur.status === "PENDING") continue;
    if (cur.status === "SUCCEEDED" || cur.status === "FAILED") await setTaskStatus(cur, "PENDING", { attempts: 0, completedAt: null, verification: "NONE" });
  }
  await prisma.mission.update({ where: { id: m.id }, data: { repairRounds: { increment: 1 } } });
  m.repairRounds = fresh.repairRounds + 1;
  await event(m.companyId, m.id, `${outcome.reason}: repair round ${fresh.repairRounds + 1}/${fresh.maxRepairs} for ${outcome.findingCodes.join(", ")} (${[...ups].join(", ")} re-opened)`, "warning", task.agentKey, { taskKey: task.key, runId, findings: outcome.findingCodes });
}

async function finish(m: Mission, to: "COMPLETED" | "FAILED", reason: string) {
  await setMissionStatus(m, to, reason, { completedAt: new Date() });
  await prisma.missionTask.updateMany({ where: { missionId: m.id, status: { in: ["PENDING", "READY"] } }, data: { status: "SKIPPED", output: `Not run: mission ${to.toLowerCase()}` } });
  await prisma.missionLock.deleteMany({ where: { missionId: m.id } });
  await event(m.companyId, m.id, `Mission ${to.toLowerCase()}: ${reason}`, to === "COMPLETED" ? "success" : "danger", undefined, { analytics: to === "COMPLETED" ? "mission_completed" : "mission_failed" });
}

/**
 * Human decision on an approval gate. Re-validates that the code being approved
 * is byte-identical to what was tested and reviewed (payload hash).
 */
export async function decideApproval(approvalId: string, companyId: string, decision: "approve" | "reject", actor: string, note = "") {
  const a = await prisma.missionApproval.findFirst({ where: { id: approvalId, companyId } });
  if (!a) throw new MissionError("Approval not found", 404);
  if (a.status !== "PENDING") throw new MissionError(`Approval already ${a.status.toLowerCase()}`, 409);
  const m = await prisma.mission.findFirst({ where: { id: a.missionId, companyId } });
  if (!m) throw new MissionError("Mission not found", 404);
  assertMutable(m);
  if (a.expiresAt && a.expiresAt.getTime() < Date.now()) {
    await prisma.missionApproval.update({ where: { id: a.id }, data: { status: "EXPIRED" } });
    throw new MissionError("Approval request expired", 409);
  }
  const task = await prisma.missionTask.findFirst({ where: { missionId: m.id, planVersion: m.planVersion, key: a.taskKey ?? "" } });
  if (!task || task.status !== "WAITING_APPROVAL") throw new MissionError("Gated task is not waiting for approval", 409);

  if (decision === "approve" && (await currentHash(m)) !== a.payloadHash) {
    await prisma.missionApproval.update({ where: { id: a.id }, data: { status: "CANCELLED", note: "Change differs from the reviewed version" } });
    throw new MissionError("The change was modified after this approval was requested; a new review is required", 409);
  }
  await prisma.missionApproval.update({ where: { id: a.id }, data: { status: decision === "approve" ? "APPROVED" : "REJECTED", decidedBy: actor, decidedAt: new Date(), note: note.slice(0, 500) } });
  await audit(companyId, actor, decision === "approve" ? "MISSION_APPROVAL_GRANTED" : "MISSION_APPROVAL_DENIED", a.id, a.action);
  if (decision === "approve") await setTaskStatus(task, "SUCCEEDED", { output: `Approved by operator${note ? `: ${note}` : ""}`, verification: "PASSED", completedAt: new Date() });
  else await setTaskStatus(task, "FAILED", { output: `Rejected by operator${note ? `: ${note}` : ""}`, errorCategory: "approval_rejected", completedAt: new Date() });
  if (m.status === "PAUSED" && !m.operatorHold) await setMissionStatus(m, "RUNNING", "Approval decided");
  await event(companyId, m.id, `Approval ${decision === "approve" ? "granted" : "rejected"} by operator`, decision === "approve" ? "success" : "warning", undefined, { taskKey: task.key, actor: "human" });
}

export async function cancelMission(missionId: string, companyId: string, actor: string) {
  const m = await prisma.mission.findFirst({ where: { id: missionId, companyId } });
  if (!m) throw new MissionError("Mission not found", 404);
  assertMutable(m);
  if (TERMINAL_MISSION.includes(m.status as MissionStatus)) throw new MissionError(`Mission already ${m.status.toLowerCase()}`, 409);
  await setMissionStatus(m, "CANCELLED", `Cancelled by ${actor}`, { completedAt: new Date() });
  // Cancellation propagates: queued work is skipped; a task currently executing is stopped before its next model call.
  await prisma.missionTask.updateMany({ where: { missionId, status: { in: ["PENDING", "READY", "WAITING_APPROVAL"] } }, data: { status: "SKIPPED", output: "Mission cancelled" } });
  await prisma.missionApproval.updateMany({ where: { missionId, status: "PENDING" }, data: { status: "CANCELLED" } });
  await audit(companyId, actor, "MISSION_CANCELLED", m.id, m.title);
  await event(companyId, m.id, "Mission cancelled", "warning");
}

/** Run steps until the mission needs a human or finishes (bounded). */
export async function runUntilBlocked(missionId: string, companyId: string, maxSteps = 20): Promise<AdvanceResult> {
  let last: AdvanceResult = { status: "", progressed: false };
  for (let i = 0; i < maxSteps; i++) {
    last = await advanceMission(missionId, companyId);
    if (!last.progressed || TERMINAL_MISSION.includes(last.status as MissionStatus) || last.status === "PAUSED" || last.waitingOn) break;
  }
  return last;
}

/**
 * Operator hold: pause a RUNNING/READY mission so no further task is claimed.
 * A step already executing finishes; nothing new starts. Reversible via resumeMission.
 */
export async function pauseMission(missionId: string, companyId: string, actor: string, reason = "Paused by operator") {
  const m = await prisma.mission.findFirst({ where: { id: missionId, companyId } });
  if (!m) throw new MissionError("Mission not found", 404);
  assertMutable(m);
  if (m.status === "READY") {
    // READY → RUNNING → PAUSED keeps the state machine's single path.
    await setMissionStatus(m, "RUNNING", "Started for operator hold", { startedAt: m.startedAt ?? new Date() });
  }
  if (m.status !== "RUNNING") throw new MissionError(`Only a running mission can be paused (mission is ${m.status.toLowerCase()})`, 409);
  await setMissionStatus(m, "PAUSED", reason, { operatorHold: true });
  await audit(companyId, actor, "MISSION_PAUSED", m.id, reason);
  await event(companyId, m.id, `Mission paused: ${reason}`, "warning", undefined, { actor });
  return { status: "PAUSED" };
}

export async function resumeMission(missionId: string, companyId: string, actor: string) {
  const m = await prisma.mission.findFirst({ where: { id: missionId, companyId } });
  if (!m) throw new MissionError("Mission not found", 404);
  assertMutable(m);
  if (m.status !== "PAUSED" || !m.operatorHold) throw new MissionError("Mission is not on an operator hold", 409);
  // If an approval gate is also waiting, the next advance re-pauses on it.
  await setMissionStatus(m, "RUNNING", `Resumed by ${actor}`, { operatorHold: false });
  await audit(companyId, actor, "MISSION_RESUMED", m.id, "resumed");
  await event(companyId, m.id, "Mission resumed", "info", undefined, { actor });
  return { status: "RUNNING" };
}

/** Failure categories a retry can plausibly fix without changing anything (transient). */
export const RETRYABLE_CATEGORIES = ["tool_timeout", "tool_execution_error", "worker_lost", "provider_error", "invalid_structured_output", "sandbox_failure"];

/**
 * Retry a FAILED task whose failure was transient: the task and everything
 * skipped because of it go back to PENDING, and a FAILED mission is re-opened
 * as RUNNING. Non-transient failures (tests, review, policy, budget) are refused.
 */
export async function retryTask(missionId: string, companyId: string, taskKey: string, actor: string, opts: { clearToolTimeouts?: boolean } = {}) {
  const m = await prisma.mission.findFirst({ where: { id: missionId, companyId } });
  if (!m) throw new MissionError("Mission not found", 404);
  assertMutable(m);
  if (m.status === "CANCELLED" || m.status === "COMPLETED") throw new MissionError(`Mission is ${m.status.toLowerCase()}`, 409);
  const task = await prisma.missionTask.findFirst({ where: { missionId, planVersion: m.planVersion, key: taskKey } });
  if (!task) throw new MissionError("Task not found", 404);
  if (task.status !== "FAILED") throw new MissionError(`Task is ${task.status.toLowerCase()}, not failed`, 409);
  if (!RETRYABLE_CATEGORIES.includes(task.errorCategory ?? "")) throw new MissionError(`A ${task.errorCategory ?? "unknown"} failure is not transient; retrying would repeat it`, 409);
  if (m.costUsd >= m.budgetUsd) throw new MissionError("Mission budget is exhausted; raise the budget before retrying", 409);

  const tasks = await prisma.missionTask.findMany({ where: { missionId, planVersion: m.planVersion } });
  const graph = tasks.map((t) => ({ key: t.key, dependsOn: parseJSON<string[]>(t.dependsOn, []), status: t.status }));
  const reopen = [taskKey, ...descendants(graph, taskKey)];
  await setTaskStatus(task, "PENDING", { attempts: 0, completedAt: null, verification: "NONE", errorCategory: null, output: `${task.output}\nRetry requested by ${actor}.`.trim() });
  await prisma.missionTask.updateMany({ where: { missionId, planVersion: m.planVersion, key: { in: reopen.filter((k) => k !== taskKey) }, status: "SKIPPED" }, data: { status: "PENDING", output: "" } });
  if (opts.clearToolTimeouts && m.toolTimeouts !== "{}") {
    await prisma.mission.update({ where: { id: m.id }, data: { toolTimeouts: "{}" } });
    await audit(companyId, actor, "MISSION_TOOL_TIMEOUTS_CLEARED", m.id, m.toolTimeouts);
  }
  if (m.status === "FAILED") {
    // FAILED is terminal in the normal machine; a retry is an explicit, audited re-open.
    await prisma.mission.updateMany({ where: { id: m.id, status: "FAILED" }, data: { status: "RUNNING", statusReason: `Retry of ${taskKey} requested by ${actor}`, completedAt: null } });
    await audit(companyId, actor, "MISSION_STATUS", m.id, `FAILED → RUNNING: retry of ${taskKey}`);
  }
  await audit(companyId, actor, "TASK_RETRY", `${m.id}:${taskKey}`, task.errorCategory ?? "");
  await event(companyId, m.id, `Retry of "${task.title}" requested`, "info", undefined, { taskKey, actor });
  return { taskKey, reopened: reopen };
}
