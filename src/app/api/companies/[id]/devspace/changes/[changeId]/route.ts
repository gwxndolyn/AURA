import { z } from "zod";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { lineDiff } from "@/lib/missions/diff";
import { getWorkspace, readFile } from "@/lib/devspace/files";
import { proposedContent, acceptanceBlockers, requiresApproval, acceptChange, rejectChange, revertChange, requestRevision } from "@/lib/devspace/changes";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string; changeId: string }> };

/** Full review payload: before/after, diff, provenance, evidence, blockers, checks. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, changeId } = await ctx.params;
  const { role } = await requireWorkspaceAccess(id, "VIEWER");
  const c = await prisma.fileChange.findFirst({ where: { id: changeId, companyId: id } });
  if (!c) throw new ApiError("Change not found", 404);
  const after = (await proposedContent(c)) ?? "";
  // "before" = the content at the change's base revision (recorded FileVersion), not whatever is current now.
  const baseVer = await prisma.fileVersion.findFirst({ where: { companyId: id, workspaceId: c.workspaceId, path: c.path, fileRev: c.baseRev }, orderBy: { revision: "desc" } });
  const before = c.baseRev === 0 ? "" : baseVer?.content ?? "";
  const current = readFile(await getWorkspace(id), c.path);
  const [mission, run, checks, tests] = await Promise.all([
    c.missionId ? prisma.mission.findFirst({ where: { id: c.missionId, companyId: id }, select: { id: true, title: true, status: true, acceptance: true, risk: true } }) : null,
    c.runId ? prisma.missionTaskRun.findFirst({ where: { id: c.runId, companyId: id }, select: { id: true, agentKey: true, taskKey: true, attempt: true, claims: true, output: true, startedAt: true } }) : null,
    prisma.execRun.findMany({ where: { companyId: id, changeId: c.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    c.missionId ? prisma.missionArtifact.findMany({ where: { companyId: id, missionId: c.missionId, kind: "TEST_REPORT" }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, meta: true, createdAt: true } }) : [],
  ]);
  const latestCheck = checks.find((x) => x.status !== "QUEUED") ?? null;
  return ok({
    ...c,
    history: parseJSON(c.history, []),
    verification: parseJSON(c.verification, {}),
    before,
    after,
    diff: lineDiff(before, after),
    current: current ? { rev: current.rev, sha256: current.sha256, matchesProposed: current.sha256 === c.newSha256, matchesBase: current.rev === c.baseRev } : null,
    mission: mission ? { ...mission, acceptance: parseJSON<string[]>(mission.acceptance, []) } : null,
    run: run ? { ...run, output: parseJSON(run.output, {}) } : null,
    missionTests: tests.map((t) => ({ ...t, meta: parseJSON(t.meta, {}) })),
    checks,
    blockers: await acceptanceBlockers(c, { latestCheck }),
    requiresApproval: requiresApproval(c),
    canDecide: role === "ADMIN" || role === "OWNER",
  });
});

const Schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), confirmHighRisk: z.boolean().optional(), note: z.string().max(500).optional() }),
  z.object({ action: z.literal("reject"), note: z.string().max(500).optional() }),
  z.object({ action: z.literal("revert") }),
  z.object({ action: z.literal("revise"), note: z.string().min(5).max(500) }),
]);

/** Human decisions. Accept/revert/revise need ADMIN; the agent never reaches this route. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, changeId } = await ctx.params;
  const body = await parseBody(req, Schema);
  const { user } = await requireWorkspaceAccess(id, body.action === "reject" ? "MEMBER" : "ADMIN");
  switch (body.action) {
    case "accept":
      return ok(await acceptChange(id, changeId, user.email, { confirmHighRisk: body.confirmHighRisk, note: body.note }));
    case "reject":
      return ok(await rejectChange(id, changeId, user.email, body.note ?? ""));
    case "revert":
      return ok(await revertChange(id, changeId, user.email));
    case "revise":
      return ok(await requestRevision(id, changeId, user.email, user.userId, body.note));
  }
});
