import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { syncMissionChanges } from "@/lib/devspace/changes";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Changes for this project; agent changes are synced from their missions' recorded artifacts first. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const missions = await prisma.mission.findMany({ where: { companyId: id, workspaceId: { not: null }, status: { in: ["RUNNING", "PAUSED", "COMPLETED", "FAILED"] } }, select: { id: true }, orderBy: { createdAt: "desc" }, take: 20 });
  for (const m of missions) await syncMissionChanges(id, m.id);
  const rows = await prisma.fileChange.findMany({ where: { companyId: id }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, path: true, op: true, source: true, author: true, missionId: true, taskKey: true, status: true, added: true, removed: true, explanation: true, createdAt: true, appliedRevision: true, decidedBy: true } });
  return ok(rows);
});
