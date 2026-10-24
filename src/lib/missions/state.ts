/**
 * Mission + mission-task state machines. Pure, so transitions are unit-testable
 * and every status change in the engine goes through `assertTransition`.
 *
 * Mission:  DRAFT → PLANNING → AWAITING_APPROVAL → READY → RUNNING
 *           RUNNING ⇄ PAUSED (paused = waiting on a human approval gate)
 *           RUNNING → COMPLETED | FAILED ; any non-terminal → CANCELLED
 * Task:     PENDING → READY → RUNNING → SUCCEEDED | FAILED
 *           PENDING|READY → SKIPPED (dependency failed / mission cancelled)
 *           FAILED → PENDING|READY, SUCCEEDED → PENDING (bounded repair loop only)
 *           RUNNING → WAITING_APPROVAL → SUCCEEDED | FAILED (approval decided)
 *           RUNNING → SKIPPED (mission cancelled while the step was executing)
 */

export const MISSION_STATUSES = [
  "DRAFT",
  "PLANNING",
  "AWAITING_APPROVAL",
  "READY",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const TASK_STATUSES = ["PENDING", "READY", "RUNNING", "WAITING_APPROVAL", "SUCCEEDED", "FAILED", "SKIPPED"] as const;
export type MissionTaskStatus = (typeof TASK_STATUSES)[number];

const MISSION_TRANSITIONS: Record<MissionStatus, MissionStatus[]> = {
  DRAFT: ["PLANNING", "CANCELLED"],
  PLANNING: ["AWAITING_APPROVAL", "READY", "FAILED", "CANCELLED"],
  AWAITING_APPROVAL: ["READY", "PLANNING", "CANCELLED"],
  READY: ["RUNNING", "CANCELLED"],
  RUNNING: ["PAUSED", "COMPLETED", "FAILED", "CANCELLED"],
  PAUSED: ["RUNNING", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

const TASK_TRANSITIONS: Record<MissionTaskStatus, MissionTaskStatus[]> = {
  PENDING: ["READY", "SKIPPED"],
  READY: ["RUNNING", "SKIPPED"],
  RUNNING: ["SUCCEEDED", "FAILED", "WAITING_APPROVAL", "SKIPPED"], // SKIPPED: mission cancelled mid-execution
  WAITING_APPROVAL: ["SUCCEEDED", "FAILED", "SKIPPED"],
  SUCCEEDED: ["PENDING"], // re-opened by a bounded repair loop (e.g. fix task after failed verification)
  FAILED: ["PENDING", "READY", "SKIPPED"],
  SKIPPED: [],
};

export const TERMINAL_MISSION: MissionStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];
export const TERMINAL_TASK: MissionTaskStatus[] = ["SUCCEEDED", "FAILED", "SKIPPED"];

export class TransitionError extends Error {
  constructor(public from: string, public to: string, public entity: "mission" | "task") {
    super(`Illegal ${entity} transition ${from} → ${to}`);
    this.name = "TransitionError";
  }
}

export function canMission(from: MissionStatus, to: MissionStatus) {
  return MISSION_TRANSITIONS[from]?.includes(to) ?? false;
}
export function canTask(from: MissionTaskStatus, to: MissionTaskStatus) {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}
export function assertMission(from: string, to: MissionStatus) {
  if (!canMission(from as MissionStatus, to)) throw new TransitionError(from, to, "mission");
}
export function assertTask(from: string, to: MissionTaskStatus) {
  if (!canTask(from as MissionTaskStatus, to)) throw new TransitionError(from, to, "task");
}

/** Plain-language meaning, shown in the UI next to each status. */
export const MISSION_STATUS_HELP: Record<MissionStatus, string> = {
  DRAFT: "Objective recorded; no plan yet.",
  PLANNING: "AURA is turning the objective into a plan.",
  AWAITING_APPROVAL: "A plan is ready. Nothing runs until a human approves it.",
  READY: "Plan approved; tasks are queued.",
  RUNNING: "Agents are executing eligible tasks.",
  PAUSED: "Waiting on a human decision before continuing.",
  COMPLETED: "All required tasks finished and passed verification.",
  FAILED: "A required task failed or was rejected; see the report.",
  CANCELLED: "Stopped by a user; no further tasks will be scheduled.",
};
