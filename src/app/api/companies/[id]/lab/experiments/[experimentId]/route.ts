import { z } from "zod";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";
import { approveExperiment, cancelExperiment, loadState } from "@/lib/lab/lab";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; experimentId: string }> };

/**
 * start  → queues a durable `lab.experiment` job (never runs inside the request)
 * cancel → stops a proposed/running/interrupted experiment
 * approve / reject → decision on an AWAITING_APPROVAL (security-relevant) experiment
 * All ADMIN+.
 */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, experimentId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const b = await parseBody(req, z.object({ action: z.enum(["start", "cancel", "approve", "reject"]), note: z.string().max(500).optional() }));
  const e = await prisma.labExperiment.findFirst({ where: { id: experimentId, companyId: id } });
  if (!e) throw new ApiError("Experiment not found", 404);
  if (b.action === "start") {
    if ((await loadState(id)).status === "PAUSED") throw new ApiError("The improvement loop is paused", 409);
    if (!["PROPOSED", "INTERRUPTED"].includes(e.status)) throw new ApiError(`Experiment is ${e.status.toLowerCase()}`, 409);
    const job = await enqueue({ companyId: id, type: "lab.experiment", payload: { experimentId, actor: user.email }, dedupeKey: `lab:${experimentId}:${e.status}:${e.decision.length}`, maxAttempts: 1, createdBy: user.email });
    return ok({ queued: true, jobId: job.id }, { status: 202 });
  }
  if (b.action === "cancel") return ok(await cancelExperiment(id, experimentId, user.email));
  return ok(await approveExperiment(id, experimentId, user.email, b.action, b.note ?? ""));
});
