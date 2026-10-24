import { ok, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseManifest } from "@/lib/learning/retrieval";
import { parseJSON } from "@/lib/utils";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; buildId: string }> };

/** What a run learned from and produced: retrieval explanation, outcome, attributions, task memory. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, buildId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const b = await prisma.build.findFirst({ where: { id: buildId, companyId: id }, select: { id: true, itemKey: true, productId: true, retrievalManifest: true, taskMemory: true } });
  if (!b) throw new ApiError("Run not found", 404);
  const [outcome, attributions, events] = await Promise.all([
    prisma.runOutcome.findFirst({ where: { buildId, companyId: id } }),
    prisma.failureAttribution.findMany({ where: { buildId, companyId: id }, orderBy: { attempt: "asc" } }),
    prisma.learningEvent.findMany({ where: { buildId, companyId: id }, orderBy: { createdAt: "asc" }, select: { type: true, key: true, processedAt: true, error: true, createdAt: true } }),
  ]);
  const tm = parseJSON<{ approaches?: unknown[]; updatedAt?: string }>(b.taskMemory, {});
  return ok({ buildId, itemKey: b.itemKey, retrieved: parseManifest(b.retrievalManifest), taskMemory: { approaches: tm.approaches ?? [], updatedAt: tm.updatedAt ?? null }, outcome, attributions, events });
});
