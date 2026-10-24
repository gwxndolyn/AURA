/**
 * Shared persistence helpers for the mission engine. Every write is scoped to
 * a mission row that was loaded with `findFirst({ id, companyId })`.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { emitEvent, audit } from "@/lib/events/emit";
import { assertMission, assertTask, type MissionStatus } from "./state";

/** Engine errors carry an HTTP status so route handlers surface them via handler(). */
export class MissionError extends ApiError {
  constructor(message: string, status = 400) {
    super(message, status);
    this.name = "MissionError";
  }
}

export type Mission = NonNullable<Awaited<ReturnType<typeof prisma.mission.findFirst>>>;
export type Task = NonNullable<Awaited<ReturnType<typeof prisma.missionTask.findFirst>>>;
export type Run = NonNullable<Awaited<ReturnType<typeof prisma.missionTaskRun.findFirst>>>;

export async function event(companyId: string, missionId: string, message: string, level: "info" | "success" | "warning" | "danger" = "info", actor?: string, meta: Record<string, unknown> = {}) {
  await emitEvent({ companyId, type: "MISSION_UPDATED", actor, level, message, meta: { missionId, ...meta } });
}

export async function setMissionStatus(m: Mission, to: MissionStatus, reason = "", extra: Record<string, unknown> = {}) {
  assertMission(m.status, to);
  // Optimistic concurrency: only transition from the status we read.
  const res = await prisma.mission.updateMany({ where: { id: m.id, status: m.status }, data: { status: to, statusReason: reason, ...extra } });
  if (res.count !== 1) throw new MissionError("Mission changed concurrently; retry", 409);
  await audit(m.companyId, "mission-engine", "MISSION_STATUS", m.id, `${m.status} → ${to}${reason ? `: ${reason}` : ""}`);
  m.status = to;
}

export async function setTaskStatus(t: Task, to: Task["status"], data: Record<string, unknown> = {}) {
  assertTask(t.status, to as never);
  const res = await prisma.missionTask.updateMany({ where: { id: t.id, status: t.status }, data: { status: to, ...data } });
  if (res.count !== 1) throw new MissionError("Task changed concurrently; retry", 409);
  t.status = to;
}

export async function addArtifact(m: Mission, taskKey: string, kind: string, name: string, content: string, meta: Record<string, unknown> = {}) {
  const prev = await prisma.missionArtifact.count({ where: { missionId: m.id, name } });
  return prisma.missionArtifact.create({
    data: { missionId: m.id, companyId: m.companyId, taskKey, kind, name, version: prev + 1, content: content.slice(0, 60_000), meta: JSON.stringify(meta) },
  });
}

export async function accrue(missionId: string, usage: { cost?: number; modelCalls?: number; toolCalls?: number }) {
  await prisma.mission.update({
    where: { id: missionId },
    data: { costUsd: { increment: usage.cost ?? 0 }, modelCalls: { increment: usage.modelCalls ?? 0 }, toolCalls: { increment: usage.toolCalls ?? 0 } },
  });
}

/** Content hash over an explicit set of files (sorted by path) — what gets tested, reviewed and approved. */
export function hashFiles(files: Record<string, string>, paths: string[]): string {
  const h = createHash("sha256");
  for (const p of [...paths].sort()) h.update(`${p}\0${files[p] ?? ""}\0`);
  return h.digest("hex");
}

/** Next finding code for a mission (F-1, F-2, …). */
export async function nextFindingCode(missionId: string): Promise<string> {
  const n = await prisma.missionFinding.count({ where: { missionId } });
  return `F-${n + 1}`;
}

/** Release every file lock held by a task (on completion, failure, cancel or recovery). */
export async function releaseLocks(missionId: string, taskKey: string) {
  await prisma.missionLock.deleteMany({ where: { missionId, taskKey } });
}
