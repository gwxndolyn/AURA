/**
 * Product lifecycle state model (pure). One product moves through phases that
 * may overlap and may move BACKWARDS when evidence demands it (a failed check
 * returns work to BUILD, a design mismatch reopens DESIGN, a data constraint
 * found while building triggers ARCHITECTURE review). Every change is recorded
 * as a LifecycleTransition with actor, reason and evidence (see store.ts).
 *
 * Backlog item status is likewise explicit. VERIFIED can only be reached from
 * execution evidence (a completed mission whose tests ran in the sandbox and
 * whose review passed) — never by a user or agent saying "done".
 */
import { ApiError } from "@/lib/api";

export const PHASES = ["DISCOVERY", "PLANNING", "DESIGN", "ARCHITECTURE", "BUILD", "VERIFY", "ITERATE", "RELEASE_READINESS", "DEPLOY", "OPERATE"] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_LABEL: Record<Phase, string> = {
  DISCOVERY: "Discovery & requirements",
  PLANNING: "Planning & backlog",
  DESIGN: "UX & UI design",
  ARCHITECTURE: "Technical architecture",
  BUILD: "Implementation",
  VERIFY: "Integration & verification",
  ITERATE: "Correction & refinement",
  RELEASE_READINESS: "Release readiness",
  DEPLOY: "Deployment",
  OPERATE: "Production follow-up",
};

/** Allowed phase moves. Backward edges exist on purpose (evidence-driven rework). */
const WORK: Phase[] = ["DESIGN", "ARCHITECTURE", "BUILD", "VERIFY", "ITERATE"];
/**
 * Allowed phase moves. Work phases overlap in practice, so they connect to each
 * other in both directions; release/deploy/operate are entered only through
 * explicit release actions, and every phase can return to an earlier one when
 * evidence demands rework.
 */
const PHASE_EDGES: Record<Phase, Phase[]> = {
  DISCOVERY: ["PLANNING"],
  PLANNING: ["DISCOVERY", ...WORK],
  DESIGN: ["PLANNING", ...WORK.filter((p) => p !== "DESIGN"), "RELEASE_READINESS"],
  ARCHITECTURE: ["PLANNING", ...WORK.filter((p) => p !== "ARCHITECTURE"), "RELEASE_READINESS"],
  BUILD: ["PLANNING", ...WORK.filter((p) => p !== "BUILD"), "RELEASE_READINESS"],
  VERIFY: ["PLANNING", ...WORK.filter((p) => p !== "VERIFY"), "RELEASE_READINESS"],
  ITERATE: ["PLANNING", ...WORK.filter((p) => p !== "ITERATE"), "RELEASE_READINESS"],
  RELEASE_READINESS: ["PLANNING", ...WORK, "DEPLOY"],
  DEPLOY: ["RELEASE_READINESS", "ITERATE", "OPERATE"],
  OPERATE: ["PLANNING", "ITERATE", "RELEASE_READINESS", "DEPLOY"],
};

/**
 * The phase implied by the backlog (pure). Release phases are never derived —
 * they are entered by explicit release actions — but work found later pulls
 * the product back into a work phase.
 */
export function derivePhase(current: string, items: { level: string; kind: string; status: string; executable: boolean; findingId?: string | null }[], signals: { verifying: boolean; scopeApproved: boolean }): Phase {
  if (!signals.scopeApproved) return current === "DISCOVERY" ? "DISCOVERY" : "PLANNING";
  const live = items.filter((i) => (i.level === "TASK" || i.level === "REPAIR") && i.status !== "CANCELLED");
  const active = (pred: (i: (typeof live)[number]) => boolean) => live.some((i) => pred(i) && !SETTLED.includes(i.status as ItemStatus));
  if (live.some((i) => i.level === "REPAIR" && i.status === "IN_PROGRESS") || live.some((i) => i.executable && i.status === "FAILED")) return "ITERATE";
  if (signals.verifying) return "VERIFY";
  if (active((i) => ["FRONTEND", "BACKEND", "DATA", "TEST"].includes(i.kind) && ["IN_PROGRESS", "IN_REVIEW"].includes(i.status))) return "BUILD";
  if (active((i) => i.kind === "DESIGN")) return "DESIGN";
  if (active((i) => i.kind === "ARCHITECTURE")) return "ARCHITECTURE";
  if (active(() => true)) return "BUILD";
  if (["RELEASE_READINESS", "DEPLOY", "OPERATE"].includes(current)) return current as Phase;
  return live.length ? "RELEASE_READINESS" : "PLANNING";
}

export function canMovePhase(from: string, to: string): boolean {
  return (PHASE_EDGES[from as Phase] ?? []).includes(to as Phase);
}

export const ITEM_LEVELS = ["EPIC", "STORY", "TASK", "REPAIR"] as const;
export type ItemLevel = (typeof ITEM_LEVELS)[number];

export const ITEM_STATUSES = ["TODO", "READY", "IN_PROGRESS", "IN_REVIEW", "VERIFIED", "FAILED", "BLOCKED", "DONE_UNVERIFIED", "CANCELLED"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const VERIFICATION_STATUSES = ["NOT_RUN", "RUNNING", "PASSED", "FAILED", "BLOCKED", "INCONCLUSIVE"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Terminal for scheduling purposes (does not mean "succeeded"). */
export const SETTLED: ItemStatus[] = ["VERIFIED", "DONE_UNVERIFIED", "CANCELLED"];

/**
 * Item status edges. Who may take an edge is enforced separately:
 *  - VERIFIED: only `engine` with passing evidence
 *  - DONE_UNVERIFIED: only a human, only for items with no executable backing
 */
const ITEM_EDGES: Record<ItemStatus, ItemStatus[]> = {
  TODO: ["READY", "BLOCKED", "CANCELLED", "DONE_UNVERIFIED"],
  READY: ["IN_PROGRESS", "TODO", "BLOCKED", "CANCELLED", "DONE_UNVERIFIED"],
  IN_PROGRESS: ["IN_REVIEW", "FAILED", "BLOCKED", "CANCELLED", "VERIFIED"],
  IN_REVIEW: ["VERIFIED", "FAILED", "IN_PROGRESS", "BLOCKED", "CANCELLED", "DONE_UNVERIFIED"],
  FAILED: ["READY", "IN_PROGRESS", "BLOCKED", "CANCELLED"],
  BLOCKED: ["READY", "TODO", "CANCELLED", "DONE_UNVERIFIED"],
  VERIFIED: ["READY"], // reopened when new evidence invalidates it
  DONE_UNVERIFIED: ["READY"],
  CANCELLED: ["TODO"],
};

export type Actor = { kind: "engine" | "user" | "agent"; id: string };

export class LifecycleError extends ApiError {
  constructor(message: string, status = 409) {
    super(message, status);
    this.name = "LifecycleError";
  }
}

export function assertItemMove(item: { status: string; executable: boolean; level: string }, to: ItemStatus, actor: Actor, evidence: { verified?: boolean } = {}) {
  if (item.status === to) return;
  if (!(ITEM_EDGES[item.status as ItemStatus] ?? []).includes(to)) throw new LifecycleError(`Cannot move an item from ${item.status} to ${to}`);
  if (to === "VERIFIED" && (actor.kind !== "engine" || !evidence.verified)) {
    throw new LifecycleError("Only recorded verification evidence can mark work VERIFIED — finish execution and verification first");
  }
  if (to === "DONE_UNVERIFIED") {
    if (actor.kind !== "user") throw new LifecycleError("Only a person can accept work without verification");
    if (item.executable) throw new LifecycleError("This task has an executable test suite; it must pass verification instead of being accepted manually");
  }
}

/** Roll a parent's status up from its children (stories from tasks, epics from stories). */
export function rollUp(children: { status: string }[]): ItemStatus {
  const live = children.filter((c) => c.status !== "CANCELLED");
  if (!live.length) return "TODO";
  if (live.every((c) => c.status === "VERIFIED")) return "VERIFIED";
  if (live.some((c) => c.status === "FAILED")) return "FAILED";
  if (live.some((c) => c.status === "BLOCKED")) return "BLOCKED";
  if (live.some((c) => ["IN_PROGRESS", "IN_REVIEW"].includes(c.status))) return "IN_PROGRESS";
  if (live.every((c) => SETTLED.includes(c.status as ItemStatus))) return "DONE_UNVERIFIED";
  if (live.some((c) => c.status !== "TODO")) return "IN_PROGRESS";
  return "TODO";
}

/** Ready = every dependency settled as VERIFIED (or accepted unverified, for non-executable work). */
export function readyKeys(items: { key: string; level: string; status: string; dependsOn: string[] }[]): string[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  return items
    .filter((i) => (i.level === "TASK" || i.level === "REPAIR") && ["TODO", "READY"].includes(i.status))
    .filter((i) => i.dependsOn.every((d) => {
      const dep = byKey.get(d);
      return dep && (dep.status === "VERIFIED" || dep.status === "DONE_UNVERIFIED");
    }))
    .map((i) => i.key)
    .sort();
}

/** Dependency graph must be acyclic and reference known keys. */
export function validateGraph(items: { key: string; dependsOn: string[] }[]): string[] {
  const errors: string[] = [];
  const keys = new Set(items.map((i) => i.key));
  for (const i of items) for (const d of i.dependsOn) if (!keys.has(d)) errors.push(`${i.key} depends on unknown ${d}`);
  const state = new Map<string, 0 | 1 | 2>();
  const deps = new Map(items.map((i) => [i.key, i.dependsOn]));
  const visit = (k: string, path: string[]): void => {
    if (state.get(k) === 2) return;
    if (state.get(k) === 1) {
      errors.push(`dependency cycle: ${[...path, k].join(" → ")}`);
      return;
    }
    state.set(k, 1);
    for (const d of deps.get(k) ?? []) if (keys.has(d)) visit(d, [...path, k]);
    state.set(k, 2);
  };
  for (const k of keys) visit(k, []);
  return [...new Set(errors)];
}

/**
 * Progress has ONE definition: verified executable tasks / executable tasks.
 * Non-executable tasks are reported separately (they cannot be verified here).
 */
export function progress(items: { level: string; status: string; executable: boolean }[]) {
  const tasks = items.filter((i) => (i.level === "TASK" || i.level === "REPAIR") && i.status !== "CANCELLED");
  const exec = tasks.filter((t) => t.executable);
  const verified = exec.filter((t) => t.status === "VERIFIED").length;
  return {
    definition: "verified executable tasks ÷ executable tasks (cancelled excluded); non-executable tasks are counted separately and never as verified",
    verified,
    executable: exec.length,
    ratio: exec.length ? verified / exec.length : null,
    nonExecutable: tasks.length - exec.length,
    acceptedUnverified: tasks.filter((t) => t.status === "DONE_UNVERIFIED").length,
  };
}
