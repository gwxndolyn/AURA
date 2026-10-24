/**
 * Office state mapper: authoritative execution state → visual character state.
 *
 * Pure and deterministic. The renderer (3D or 2D) only ever consumes the
 * output of `mapOfficeState`; it never decides what an agent is doing. An
 * activity is shown only when a persisted record supports it:
 *
 *   RUNNING mission task      → planning | coding | reviewing | testing (by task kind), at that kind's location
 *   WAITING_APPROVAL task     → awaiting_approval, at the release station
 *   FAILED task, mission open → blocked (the mission cannot proceed without a repair or a person)
 *   Agent.status BLOCKED / unavailable → blocked
 *   SUCCEEDED in the last few minutes  → completed (at home)
 *   (no mission task) product item IN_PROGRESS/BLOCKED or a PROPOSED
 *   design/architecture artifact → designing/planning/blocked/awaiting review
 *   anything else             → idle (at home), with a queued count if READY/PENDING work is assigned
 *
 * Visual state (where to stand, which pose) is kept separate from execution
 * state (`exec`), which is passed through untouched for the inspector.
 */
import { HOME, LOCATION_BY_ID, SEAT_BY_ID, locationForTaskKind, type LocationId } from "./layout";

export type Activity = "idle" | "planning" | "designing" | "coding" | "reviewing" | "testing" | "blocked" | "awaiting_approval" | "completed";

export interface OfficeAgentInput {
  key: string;
  name: string;
  role: string;
  status: string; // Agent.status
  available: boolean;
}

export interface OfficeTaskInput {
  id: string;
  key: string;
  title: string;
  kind: string;
  agentKey: string;
  status: string; // MissionTask.status
  verification?: string;
  missionId: string;
  missionTitle: string;
  missionStatus: string;
  startedAt?: string | null;
  completedAt?: string | null;
  leaseExpiresAt?: string | null;
  output?: string;
}

/**
 * Product-lifecycle work that is not (yet) a running mission task: a backlog
 * item owned by an agent (IN_PROGRESS / BLOCKED) or an artifact it produced
 * that waits for human review (PROPOSED). Lower precedence than mission tasks.
 */
export interface OfficeWorkInput {
  id: string;
  agentKey: string;
  kind: "item" | "artifact";
  title: string;
  status: string; // BacklogItem.status or ProductArtifact.status
  itemKind?: string; // BacklogItem.kind / ProductArtifact.kind (DESIGN, ARCHITECTURE, …)
  productId: string;
  productTitle: string;
  blockedReason?: string;
  missionId?: string | null;
}

export interface OfficeInteraction {
  id: string;
  kind: "handoff" | "finding" | "approval" | "review_request";
  from: string; // agent key
  to: string[]; // agent keys, or "you" for a human gate
  text: string;
  at: string;
  href?: string;
  /** True when this interaction is part of a scripted demo fixture, not a persisted record. */
  demo?: boolean;
}

export interface VisualAgent {
  key: string;
  name: string;
  role: string;
  activity: Activity;
  location: LocationId;
  seatId: string;
  /** Short human-readable status line, derived from the record that justifies the activity. */
  label: string;
  task?: { id: string; key: string; title: string; kind: string; status: string; missionId: string; missionTitle: string; verification?: string };
  work?: OfficeWorkInput;
  queued: number;
  /** True when the running task's lease has expired (worker silent): shown, but flagged. */
  stale: boolean;
  /** Partner agent keys in a recent interaction (face each other / draw a link). */
  interactionWith: string[];
  exec: { agentStatus: string; available: boolean; taskStatus?: string };
}

const KIND_ACTIVITY: Record<string, Activity> = {
  REQUIREMENTS: "planning",
  ANALYSIS: "planning",
  ARCHITECTURE: "planning",
  REPORT: "planning",
  CODE_CHANGE: "coding",
  REVIEW: "reviewing",
  SECURITY_REVIEW: "reviewing",
  REPRODUCE: "testing",
  TEST: "testing",
  APPROVAL: "awaiting_approval",
};

export const ACTIVITY_LABEL: Record<Activity, string> = {
  idle: "Idle",
  planning: "Planning",
  designing: "Designing",
  coding: "Coding",
  reviewing: "Reviewing",
  testing: "Testing",
  blocked: "Blocked",
  awaiting_approval: "Awaiting approval",
  completed: "Completed",
};

const TERMINAL_MISSION = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const COMPLETED_WINDOW_MS = 5 * 60_000;
const INTERACTION_WINDOW_MS = 10 * 60_000;

const ms = (s?: string | null) => (s ? Date.parse(s) : NaN);

function pickTask(tasks: OfficeTaskInput[], now: number) {
  const byRecency = (a: OfficeTaskInput, b: OfficeTaskInput) => (ms(b.startedAt ?? b.completedAt) || 0) - (ms(a.startedAt ?? a.completedAt) || 0) || a.id.localeCompare(b.id);
  const open = tasks.filter((t) => !TERMINAL_MISSION.has(t.missionStatus));
  const running = open.filter((t) => t.status === "RUNNING").sort(byRecency)[0];
  if (running) return { task: running, activity: KIND_ACTIVITY[running.kind] ?? "planning" } as const;
  const waiting = open.filter((t) => t.status === "WAITING_APPROVAL").sort(byRecency)[0];
  if (waiting) return { task: waiting, activity: "awaiting_approval" } as const;
  const failed = open.filter((t) => t.status === "FAILED").sort(byRecency)[0];
  if (failed) return { task: failed, activity: "blocked" } as const;
  const done = tasks.filter((t) => t.status === "SUCCEEDED" && now - ms(t.completedAt) < COMPLETED_WINDOW_MS).sort(byRecency)[0];
  if (done) return { task: done, activity: "completed" } as const;
  return null;
}

/**
 * Map the authoritative state to one visual state per known agent. Tasks or
 * interactions that name an agent not in `agents` are ignored (a missing
 * agent never crashes the office). `now` is injected for determinism.
 */
function pickWork(work: OfficeWorkInput[]): { work: OfficeWorkInput; activity: Activity; location: LocationId; label: string } | null {
  const order = (w: OfficeWorkInput) => (w.kind === "item" && w.status === "IN_PROGRESS" ? 0 : w.kind === "item" && w.status === "BLOCKED" ? 1 : 2);
  const w = [...work].filter((x) => (x.kind === "item" ? x.status === "IN_PROGRESS" || x.status === "BLOCKED" : x.status === "PROPOSED")).sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id))[0];
  if (!w) return null;
  const design = w.itemKind === "DESIGN";
  const arch = w.itemKind === "ARCHITECTURE";
  if (w.kind === "artifact") return { work: w, activity: "awaiting_approval", location: design ? "design" : "planning", label: `${design ? "Design" : arch ? "Architecture" : "Artifact"} waiting for your review: ${w.title}` };
  if (w.status === "BLOCKED") return { work: w, activity: "blocked", location: design ? "design" : arch ? "planning" : "engineering", label: `${w.title} is blocked${w.blockedReason ? `: ${w.blockedReason}` : ""}` };
  if (design) return { work: w, activity: "designing", location: "design", label: w.title };
  if (arch) return { work: w, activity: "planning", location: "planning", label: w.title };
  return null; // other item kinds execute through missions; the mission task drives the office
}

export function mapOfficeState(input: { agents: OfficeAgentInput[]; tasks: OfficeTaskInput[]; work?: OfficeWorkInput[]; interactions?: OfficeInteraction[]; now: number }): VisualAgent[] {
  const { agents, tasks, now } = input;
  const workBy = new Map<string, OfficeWorkInput[]>();
  for (const w of input.work ?? []) workBy.set(w.agentKey, [...(workBy.get(w.agentKey) ?? []), w]);
  const known = new Set(agents.map((a) => a.key));
  const tasksBy = new Map<string, OfficeTaskInput[]>();
  for (const t of tasks) if (known.has(t.agentKey)) tasksBy.set(t.agentKey, [...(tasksBy.get(t.agentKey) ?? []), t]);

  // Recent interactions between known agents (demo interactions are always "recent": the script controls them).
  const partners = new Map<string, Set<string>>();
  for (const i of input.interactions ?? []) {
    if (!i.demo && !(now - ms(i.at) < INTERACTION_WINDOW_MS)) continue;
    const people = [i.from, ...i.to].filter((k) => known.has(k));
    for (const a of people) for (const b of people) if (a !== b) partners.set(a, (partners.get(a) ?? new Set()).add(b));
  }

  const names = displayNames(agents);
  const sorted = [...agents].sort((a, b) => a.key.localeCompare(b.key));
  const draft = sorted.map((a) => {
    const mine = tasksBy.get(a.key) ?? [];
    const picked = pickTask(mine, now);
    const queued = mine.filter((t) => (t.status === "READY" || t.status === "PENDING") && !TERMINAL_MISSION.has(t.missionStatus)).length;
    let activity: Activity = picked?.activity ?? "idle";
    let label = "";
    const pw = !picked || picked.activity === "completed" ? pickWork(workBy.get(a.key) ?? []) : null;
    if (pw) activity = pw.activity;
    if (!picked && !pw && (a.status === "BLOCKED" || !a.available)) {
      activity = "blocked";
      label = a.available ? "Agent reported blocked" : "Agent unavailable";
    }
    const t = pw ? undefined : picked?.task;
    const stale = !!t && t.status === "RUNNING" && Number.isFinite(ms(t.leaseExpiresAt)) && ms(t.leaseExpiresAt) < now;
    if (t) {
      label =
        activity === "blocked" ? `${t.title} failed` :
        activity === "awaiting_approval" ? `Waiting for a person to approve: ${t.title}` :
        activity === "completed" ? `Finished: ${t.title}` :
        t.title;
      if (stale) label += " (no heartbeat — lease expired)";
    } else if (pw) label = pw.label;
    else if (activity === "idle") label = queued ? `${queued} task${queued === 1 ? "" : "s"} queued` : "No assigned work";
    const home = HOME[a.key] ?? "sofa-2";
    const homeLoc = SEAT_BY_ID[home]?.location ?? "lounge";
    const location: LocationId =
      pw ? pw.location :
      activity === "awaiting_approval" ? "deploy" :
      t && (activity === "planning" || activity === "coding" || activity === "reviewing" || activity === "testing") ? locationForTaskKind(t.kind) ?? homeLoc :
      homeLoc;
    return {
      key: a.key,
      name: names[a.key],
      role: a.role,
      activity,
      location,
      seatId: home,
      label,
      work: pw?.work,
      task: t ? { id: t.id, key: t.key, title: t.title, kind: t.kind, status: t.status, missionId: t.missionId, missionTitle: t.missionTitle, verification: t.verification } : undefined,
      queued,
      stale,
      interactionWith: [...(partners.get(a.key) ?? [])].sort(),
      exec: { agentStatus: a.status, available: a.available, taskStatus: t?.status },
    } satisfies VisualAgent;
  });

  // Seat allocation: deterministic. Agents keep their home seat when it lies in
  // their target location; others take the first free seat there (by key order),
  // falling back to home when the location is full.
  const taken = new Set<string>();
  for (const v of draft) if (SEAT_BY_ID[v.seatId]?.location === v.location) taken.add(v.seatId);
  for (const v of draft) {
    if (SEAT_BY_ID[v.seatId]?.location === v.location) continue;
    const free = LOCATION_BY_ID[v.location].seats.find((s) => !taken.has(s.id));
    if (free) {
      v.seatId = free.id;
      taken.add(free.id);
    } else {
      v.location = SEAT_BY_ID[v.seatId]?.location ?? "lounge";
    }
  }
  return draft;
}

/**
 * Display names: agent names are not unique in the registry (e.g. two roles can
 * share a name), so a colliding name gets a short role suffix.
 */
export function displayNames<T extends { key: string; name: string; role: string }>(agents: T[]): Record<string, string> {
  const count = new Map<string, number>();
  for (const a of agents) count.set(a.name, (count.get(a.name) ?? 0) + 1);
  const short = (role: string) => role.replace(/ engineer$/i, "").replace(/^code /i, "").split(/[\s/]/)[0];
  return Object.fromEntries(agents.map((a) => [a.key, (count.get(a.name) ?? 0) > 1 ? `${a.name} · ${short(a.role)}` : a.name]));
}

/** Records that justify an agent being at a location — for the location panel. */
export function agentsAt(visual: VisualAgent[], loc: LocationId) {
  return visual.filter((v) => v.location === loc);
}
