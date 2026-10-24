import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { compareRuns, decodeRun, reviewRun } from "@/lib/twin/runs";
import { operationalMetrics } from "@/lib/twin/metrics";
import { advise } from "@/lib/twin/adviser";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({ question: z.string().min(5).max(500), runIds: z.array(z.string().max(40)).min(1).max(4) });

/** AI adviser over engine output (falls back to the engine's explanation). Never executes anything. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, Schema);
  const comparison = body.runIds.length > 1 ? await compareRuns(id, body.runIds) : null;
  const first = await prisma.twinRun.findFirst({ where: { id: body.runIds[0], companyId: id } });
  const review = first ? reviewRun(decodeRun(first)) : [];
  const ops = (await operationalMetrics(id)).map((m) => ({ key: m.key, value: m.value }));
  return ok(await advise({ question: body.question, comparison, review: [...review, ...(comparison?.explanations.flatMap((e) => e.notes) ?? [])], operational: ops, knownRefs: [...body.runIds, ...ops.map((o) => o.key), ...(comparison?.metrics.map((m) => m.key) ?? [])] }));
});
