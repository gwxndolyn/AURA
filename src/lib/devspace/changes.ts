/**
 * Agent change review: FileChange records and their lifecycle.
 *
 * Flow:
 *   startProjectMission  — a mission is created against the project; the files
 *                          in scope are snapshotted (baseRevision + baseFiles)
 *   syncMissionChanges   — after the mission runs, the mission's latest FILE
 *                          artifact per path becomes ONE FileChange (proposed
 *                          content stays in the artifact — no duplicate copy);
 *                          status mirrors the mission's own verification
 *   acceptChange         — a person applies it to the project (CAS on the
 *                          base revision → CONFLICT if the file moved)
 *   rejectChange / revertChange / requestRevision
 *
 * Statuses (FileChange.status):
 *   PROPOSED → VERIFICATION_PENDING → VERIFIED | VERIFICATION_FAILED
 *   VERIFIED → ACCEPTED (applied) → REVERTED
 *   any open → REJECTED | CONFLICT | SUPERSEDED
 * "Accepted" is only ever set by a human decision, never by an agent finishing.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { parseJSON } from "@/lib/utils";
import { audit, emitEvent } from "@/lib/events/emit";
import { lineDiff } from "@/lib/missions/diff";
import { repoFor, REPOS } from "@/lib/missions/repos";
import { createMission, planMission } from "@/lib/missions/engine";
import { getWorkspace, filesOf, revsOf, applyWrites, ensureBaseline, sha, ConflictError } from "./files";

export const OPEN_STATUSES = ["PROPOSED", "VERIFICATION_PENDING", "VERIFICATION_FAILED", "VERIFIED"] as const;
const RISKY = /checkout|payment|auth|security/i;

type Change = NonNullable<Awaited<ReturnType<typeof prisma.fileChange.findFirst>>>;
type HistoryEntry = { at: string; actor: string; change: string; detail?: string };
const push = (raw: string, e: Omit<HistoryEntry, "at">) => JSON.stringify([...parseJSON<HistoryEntry[]>(raw, []), { at: new Date().toISOString(), ...e }].slice(-50));

/** Seed an empty project with a fixture repository (deterministic sample project). */
export async function seedProjectFromFixture(companyId: string, template: keyof typeof REPOS, actor: string) {
  const repo = REPOS[template];
  const ws = await getWorkspace(companyId);
  const files = filesOf(ws);
  const missing = Object.keys(repo.files).filter((p) => !(p in files));
  if (!missing.length) return { revision: ws.revision, added: [] as string[] };
  const r = await applyWrites(companyId, missing.map((p) => ({ path: p, content: repo.files[p], expectedRev: 0 })), actor, { reason: `imported sample project "${repo.title}"` });
  await prisma.codeWorkspace.update({ where: { id: ws.id }, data: { template } });
  return { revision: r.revision, added: missing };
}

/**
 * Create a mission that works on the project: the in-scope files are
 * snapshotted from the CURRENT project revision, so the agents operate on
 * what the user sees, and acceptance later detects if the project moved.
 */
export async function startProjectMission(companyId: string, userId: string, objective: string, opts: { template?: string; risk?: "LOW" | "MEDIUM" | "HIGH"; maxRepairs?: number; title?: string } = {}) {
  const ws = await ensureBaseline(companyId);
  const files = filesOf(ws);
  const m = await createMission({ companyId, createdById: userId, objective, template: opts.template, risk: opts.risk, maxRepairs: opts.maxRepairs, title: opts.title });
  const repo = repoFor(m.template);
  if (!repo) {
    await prisma.mission.update({ where: { id: m.id }, data: { workspaceId: ws.id, baseRevision: ws.revision } });
    await planMission(m.id, companyId);
    return { missionId: m.id, scoped: false, note: "No executable fixture matches this objective; the mission will analyze only." };
  }
  const scope = [...repo.sourceFiles, ...repo.testFiles];
  const missing = scope.filter((p) => !(p in files));
  if (missing.length) throw new ApiError(`The project is missing ${missing.join(", ")} — import the sample project first`, 409);
  const revs = revsOf(ws);
  await prisma.mission.update({ where: { id: m.id }, data: { workspaceId: ws.id, baseRevision: ws.revision, baseFiles: JSON.stringify(Object.fromEntries(scope.map((p) => [p, files[p]]))), baseFileRevs: JSON.stringify(Object.fromEntries(scope.map((p) => [p, revs[p] ?? 0]))) } });
  await planMission(m.id, companyId);
  return { missionId: m.id, scoped: true, baseRevision: ws.revision };
}

/** Map the mission's verification state to a change status. */
function statusFromMission(m: { status: string }, tasks: { kind: string; status: string; verification: string }[], findingsOpen: number): string {
  const tests = tasks.filter((t) => t.kind === "TEST");
  const reviews = tasks.filter((t) => t.kind === "REVIEW");
  const failed = [...tests, ...reviews].some((t) => t.status === "FAILED") || (m.status === "FAILED" && findingsOpen > 0);
  if (failed && m.status !== "RUNNING") return "VERIFICATION_FAILED";
  const allPassed = tests.length > 0 && [...tests, ...reviews].every((t) => t.status === "SUCCEEDED" && t.verification === "PASSED");
  if (allPassed && findingsOpen === 0) return "VERIFIED";
  return tests.some((t) => t.status !== "PENDING") ? "VERIFICATION_PENDING" : "PROPOSED";
}

/**
 * Create/refresh the FileChange for each file the mission's agents changed.
 * Idempotent: one open change per (mission, path); a newer artifact
 * supersedes nothing — it updates the same record (the history shows it).
 */
export async function syncMissionChanges(companyId: string, missionId: string) {
  const m = await prisma.mission.findFirst({ where: { id: missionId, companyId } });
  if (!m || !m.workspaceId) return [];
  const base = parseJSON<Record<string, string>>(m.baseFiles, {});
  const ws = await prisma.codeWorkspace.findFirst({ where: { id: m.workspaceId, companyId } });
  if (!ws) return [];
  // The revisions the agents worked FROM (snapshotted at mission start), not the project's current ones.
  const baseRevs = parseJSON<Record<string, number>>(m.baseFileRevs, {});
  const [tasks, findingsOpen, fileArts] = await Promise.all([
    prisma.missionTask.findMany({ where: { missionId, planVersion: m.planVersion }, select: { kind: true, status: true, verification: true, key: true } }),
    prisma.missionFinding.count({ where: { missionId, blocking: true, status: { in: ["OPEN", "UNRESOLVED"] } } }),
    prisma.missionArtifact.findMany({ where: { missionId, kind: "FILE" }, orderBy: { version: "desc" } }),
  ]);
  const latestByPath = new Map<string, (typeof fileArts)[number]>();
  for (const a of fileArts) if (!latestByPath.has(a.name)) latestByPath.set(a.name, a);
  const status = statusFromMission(m, tasks, findingsOpen);
  const out: Change[] = [];
  for (const [path, art] of latestByPath) {
    const before = base[path] ?? "";
    const d = lineDiff(before, art.content);
    const diffArt = await prisma.missionArtifact.findFirst({ where: { missionId, kind: "DIFF", name: { startsWith: `${path} (attempt` } }, orderBy: { createdAt: "desc" } });
    const meta = parseJSON<{ runId?: string; change?: string }>(art.meta, {});
    const run = meta.runId ? await prisma.missionTaskRun.findFirst({ where: { id: meta.runId, companyId }, select: { id: true, taskKey: true, agentKey: true, claims: true } }) : null;
    const syncKey = `${missionId}:${path}`;
    const existing = await prisma.fileChange.findFirst({ where: { companyId, syncKey } });
    const verification = JSON.stringify(await verificationSummary(missionId));
    if (existing && !(OPEN_STATUSES as readonly string[]).includes(existing.status)) continue; // decided: never re-opened
    if (existing) {
      const moved = existing.fileArtifactId !== art.id || existing.status !== status;
      const row = moved
        ? await prisma.fileChange.update({
            where: { id: existing.id },
            data: { fileArtifactId: art.id, diffArtifactId: diffArt?.id ?? null, newSha256: sha(art.content), added: d.added, removed: d.removed, runId: run?.id ?? existing.runId, explanation: (meta.change ?? existing.explanation).slice(0, 600), status, verification, history: push(existing.history, { actor: "system", change: existing.fileArtifactId !== art.id ? `new revision from ${run?.taskKey ?? "agent"} (${meta.change ?? ""})` : `status ${existing.status.toLowerCase()} → ${status.toLowerCase()}` }) },
          })
        : existing;
      out.push(row);
      continue;
    }
    let row: Change;
    try {
      row = await prisma.fileChange.create({
      data: {
        syncKey,
        workspaceId: ws.id, companyId, path, op: path in base ? "modify" : "create", source: "agent", author: run?.agentKey ?? "agent",
        missionId, taskKey: run?.taskKey ?? null, runId: run?.id ?? null, fileArtifactId: art.id, diffArtifactId: diffArt?.id ?? null,
        explanation: (meta.change ?? "").slice(0, 600), baseRev: path in base ? baseRevs[path] ?? 0 : 0, baseSha256: sha(before), newSha256: sha(art.content),
        added: d.added, removed: d.removed, status, verification,
        history: JSON.stringify([{ at: new Date().toISOString(), actor: run?.agentKey ?? "agent", change: "proposed", detail: meta.change }]),
      },
    });
    } catch (e) {
      // A concurrent sync created it first (unique syncKey): use that row.
      if ((e as { code?: string }).code === "P2002") {
        const winner = await prisma.fileChange.findFirst({ where: { companyId, syncKey } });
        if (winner) out.push(winner);
        continue;
      }
      throw e;
    }
    await emitEvent({ companyId, type: "CODE_CHANGED", actor: run?.agentKey, message: `${run?.agentKey ?? "Agent"} proposed a change to ${path}`, meta: { changeId: row.id, missionId } });
    out.push(row);
  }
  return out;
}

/** The evidence a reviewer needs, all from persisted rows. */
export async function verificationSummary(missionId: string) {
  const [tests, findings, m] = await Promise.all([
    prisma.missionArtifact.findMany({ where: { missionId, kind: "TEST_REPORT" }, orderBy: { createdAt: "asc" } }),
    prisma.missionFinding.findMany({ where: { missionId }, select: { code: true, title: true, severity: true, blocking: true, status: true, supported: true } }),
    prisma.mission.findUnique({ where: { id: missionId }, select: { status: true, risk: true } }),
  ]);
  const last = tests[tests.length - 1];
  const lm = parseJSON<{ mode?: string; passed?: number; failed?: number; total?: number }>(last?.meta, {});
  return {
    missionStatus: m?.status,
    risk: m?.risk ?? "LOW",
    testRuns: tests.length,
    lastTest: last ? { artifactId: last.id, name: last.name, mode: lm.mode, passed: lm.passed, failed: lm.failed, total: lm.total } : null,
    openBlocking: findings.filter((f) => f.blocking && f.supported && (f.status === "OPEN" || f.status === "UNRESOLVED")).map((f) => `${f.code} ${f.title}`),
    resolvedFindings: findings.filter((f) => f.status === "RESOLVED").length,
  };
}

/** What must hold before a person may accept; returned to the UI as blockers. */
export async function acceptanceBlockers(c: Change, opts: { latestCheck?: { status: string } | null } = {}) {
  const blockers: string[] = [];
  const v = parseJSON<Awaited<ReturnType<typeof verificationSummary>>>(c.verification, {} as never);
  if (c.status !== "VERIFIED") blockers.push(`Change is ${c.status.toLowerCase().replace(/_/g, " ")}, not verified`);
  if (!v.lastTest || v.lastTest.mode !== "docker" || v.lastTest.failed !== 0) blockers.push("No passing test run executed in the sandbox");
  if (v.openBlocking?.length) blockers.push(`Open blocking findings: ${v.openBlocking.join("; ")}`);
  if (opts.latestCheck && opts.latestCheck.status !== "PASSED") blockers.push(`Latest workspace check on this change is ${opts.latestCheck.status.toLowerCase()}`);
  return blockers;
}

export function requiresApproval(c: Change): boolean {
  const v = parseJSON<{ risk?: string }>(c.verification, {});
  return v.risk === "HIGH" || RISKY.test(c.path);
}

async function loadChange(companyId: string, changeId: string) {
  const c = await prisma.fileChange.findFirst({ where: { id: changeId, companyId } });
  if (!c) throw new ApiError("Change not found", 404);
  return c;
}

export async function proposedContent(c: Change): Promise<string | null> {
  if (!c.fileArtifactId) return null;
  const a = await prisma.missionArtifact.findFirst({ where: { id: c.fileArtifactId, companyId: c.companyId } });
  return a?.content ?? null;
}

/**
 * Accept = apply to the project. Requires a VERIFIED change with no blockers,
 * an explicit confirmation for higher-risk changes, and that the file is still
 * at the revision the agent worked from (else CONFLICT, nothing written).
 */
export async function acceptChange(companyId: string, changeId: string, actor: string, opts: { confirmHighRisk?: boolean; note?: string } = {}) {
  const c = await loadChange(companyId, changeId);
  if (!(OPEN_STATUSES as readonly string[]).includes(c.status)) throw new ApiError(`Change is already ${c.status.toLowerCase()}`, 409);
  const latestCheck = await prisma.execRun.findFirst({ where: { companyId, changeId, status: { not: "QUEUED" } }, orderBy: { createdAt: "desc" } });
  const blockers = await acceptanceBlockers(c, { latestCheck });
  if (blockers.length) throw new ApiError(`Cannot accept: ${blockers.join("; ")}`, 409);
  if (requiresApproval(c) && !opts.confirmHighRisk) throw new ApiError("This is a higher-risk change; confirm explicitly to accept it", 428);
  const content = await proposedContent(c);
  if (content === null) throw new ApiError("Proposed content is no longer available", 410);
  try {
    const r = await applyWrites(companyId, [{ path: c.path, content, expectedRev: c.baseRev, changeId: c.id }], actor, { reason: `accepted change ${c.id.slice(-6)} to` });
    await prisma.fileChange.update({ where: { id: c.id }, data: { status: "ACCEPTED", appliedRevision: r.revision, decidedBy: actor, decidedAt: new Date(), decisionNote: opts.note ?? "", history: push(c.history, { actor, change: `accepted and applied as r${r.revision}`, detail: opts.note }) } });
    await audit(companyId, actor, "CHANGE_ACCEPTED", c.id, `${c.path} → r${r.revision}`);
    return { status: "ACCEPTED", revision: r.revision };
  } catch (e) {
    if (e instanceof ConflictError) {
      await prisma.fileChange.update({ where: { id: c.id }, data: { status: "CONFLICT", history: push(c.history, { actor: "system", change: "conflict", detail: e.message }) } });
      throw new ApiError(`${e.message}. The agent's change was made against an older version; nothing was applied.`, 409);
    }
    throw e;
  }
}

export async function rejectChange(companyId: string, changeId: string, actor: string, note = "") {
  const c = await loadChange(companyId, changeId);
  if (!(OPEN_STATUSES as readonly string[]).includes(c.status) && c.status !== "CONFLICT") throw new ApiError(`Change is already ${c.status.toLowerCase()}`, 409);
  await prisma.fileChange.update({ where: { id: c.id }, data: { status: "REJECTED", decidedBy: actor, decidedAt: new Date(), decisionNote: note, history: push(c.history, { actor, change: "rejected", detail: note }) } });
  await audit(companyId, actor, "CHANGE_REJECTED", c.id, c.path);
  return { status: "REJECTED" };
}

/**
 * Revert an accepted change: restore the file content from before it, as a
 * NEW revision (history is never rewritten). Refused if the file has changed
 * again since (that later change would be silently undone).
 */
export async function revertChange(companyId: string, changeId: string, actor: string) {
  const c = await loadChange(companyId, changeId);
  if (c.status !== "ACCEPTED" || c.appliedRevision === null) throw new ApiError("Only an accepted change can be reverted", 409);
  const ws = await getWorkspace(companyId);
  const applied = await prisma.fileVersion.findFirst({ where: { workspaceId: ws.id, path: c.path, changeId: c.id }, orderBy: { revision: "desc" } });
  if (!applied) throw new ApiError("The applied version is missing; cannot revert safely", 410);
  const currentRev = revsOf(ws)[c.path] ?? 0;
  if (currentRev !== applied.fileRev) throw new ApiError(`${c.path} has changed since this change was applied (r${applied.fileRev} → r${currentRev}); revert the later change first or edit manually`, 409);
  const prior = await prisma.fileVersion.findFirst({ where: { workspaceId: ws.id, path: c.path, revision: { lt: applied.revision } }, orderBy: { revision: "desc" } });
  const restore = prior && prior.op !== "delete" ? prior.content : null;
  if (restore !== null && sha(restore) !== c.baseSha256) throw new ApiError("The pre-change content no longer matches the recorded base; cannot revert safely", 409);
  const r = await applyWrites(companyId, [{ path: c.path, content: restore, expectedRev: currentRev, changeId: c.id }], actor, { reason: `reverted change ${c.id.slice(-6)} on` });
  await prisma.fileChange.update({ where: { id: c.id }, data: { status: "REVERTED", revertedRevision: r.revision, history: push(c.history, { actor, change: `reverted as r${r.revision}` }) } });
  await audit(companyId, actor, "CHANGE_REVERTED", c.id, `${c.path} → r${r.revision}`);
  return { status: "REVERTED", revision: r.revision };
}

/**
 * Request a bounded revision: rejects this change and starts a new project
 * mission with the reviewer's note appended to the objective. It goes through
 * normal planning and plan approval — nothing runs automatically.
 */
export async function requestRevision(companyId: string, changeId: string, actor: string, userId: string, note: string) {
  const c = await loadChange(companyId, changeId);
  if (!c.missionId) throw new ApiError("Only agent changes can be sent back for revision", 409);
  const m = await prisma.mission.findFirst({ where: { id: c.missionId, companyId } });
  if (!m) throw new ApiError("Mission not found", 404);
  await rejectChange(companyId, changeId, actor, `Revision requested: ${note}`);
  const r = await startProjectMission(companyId, userId, `${m.objective}\nReviewer note on the previous attempt: ${note.slice(0, 500)}`);
  await prisma.fileChange.update({ where: { id: c.id }, data: { history: push((await loadChange(companyId, changeId)).history, { actor, change: `revision requested → mission ${r.missionId.slice(-6)}`, detail: note }) } });
  return r;
}

/** A user's direct edit through the editor (no agent), with conflict detection. */
export async function saveUserEdit(companyId: string, actor: string, path: string, content: string, expectedRev: number) {
  const r = await applyWrites(companyId, [{ path, content, expectedRev }], actor, { reason: "edited" });
  // Open agent changes to this file were made against an older revision and can no longer apply cleanly.
  const stale = await prisma.fileChange.findMany({ where: { companyId, path: r.files[0].path, status: { in: [...OPEN_STATUSES] } } });
  for (const c of stale) {
    await prisma.fileChange.update({ where: { id: c.id }, data: { status: "CONFLICT", history: push(c.history, { actor, change: "conflict", detail: `file edited directly (r${r.files[0].rev}) after the agent's base r${c.baseRev}` }) } });
  }
  return { ...r, conflicted: stale.map((c) => c.id) };
}
