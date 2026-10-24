import { z } from "zod";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { audit } from "@/lib/events/emit";
import { cancel, retry, jobEvent } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; jobId: string }> };

/** Job detail: payload, progress, checkpoint, result, and its durable event history. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, jobId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const j = await prisma.job.findFirst({ where: { id: jobId, companyId: id } });
  if (!j) throw new ApiError("Job not found", 404);
  const events = await prisma.jobEvent.findMany({ where: { jobId, companyId: id }, orderBy: { createdAt: "asc" }, take: 500 });
  return ok({ ...j, payload: parseJSON(j.payload, {}), result: parseJSON(j.result, {}), progress: parseJSON(j.progress, {}), checkpoint: parseJSON(j.checkpoint, {}), dependsOn: parseJSON(j.dependsOn, []), events: events.map((e) => ({ ...e, data: parseJSON(e.data, {}) })) });
});

/** MEMBER: cancel / retry (resumes from checkpoint) / reprioritize. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, jobId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const b = await parseBody(req, z.union([z.object({ action: z.enum(["cancel", "retry"]) }), z.object({ action: z.literal("priority"), priority: z.number().int().min(0).max(1000) })]));
  const j = await prisma.job.findFirst({ where: { id: jobId, companyId: id } });
  if (!j) throw new ApiError("Job not found", 404);
  let changed = false;
  if (b.action === "cancel") changed = await cancel(id, jobId);
  else if (b.action === "retry") changed = await retry(id, jobId);
  else if ("priority" in b) {
    changed = (await prisma.job.updateMany({ where: { id: jobId, companyId: id, status: "QUEUED" }, data: { priority: b.priority } })).count === 1;
    if (changed) await jobEvent(j, "progress", `priority ${j.priority} → ${b.priority} by ${user.email}`);
  }
  if (!changed) throw new ApiError(`Cannot ${b.action} a ${j.status.toLowerCase()} job`, 409);
  await audit(id, user.email, "RUNTIME_JOB", jobId, b.action);
  return ok({ jobId, action: b.action });
});
