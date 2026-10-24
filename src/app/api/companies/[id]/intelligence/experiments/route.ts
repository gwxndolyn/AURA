import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { runExperiment } from "@/lib/intelligence/experiments";
import { domain } from "../_shared";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

const ExperimentSchema = z.object({
  templateKey: z.string().min(1).max(120),
  baselineVersionId: z.string().min(1).max(40),
  candidateVersionId: z.string().min(1).max(40),
  datasetId: z.string().min(1).max(60).optional(),
  repetitions: z.number().int().min(1).max(5).optional(),
  gateConfig: z
    .object({
      minPassRate: z.number().min(0).max(1).optional(),
      minStructuredValidity: z.number().min(0).max(1).optional(),
      maxCostIncrease: z.number().min(0).max(5).optional(),
      maxLatencyIncrease: z.number().min(0).max(5).optional(),
    })
    .strict()
    .optional(),
});

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  return ok(await prisma.promptExperiment.findMany({ where: { companyId: id }, orderBy: { createdAt: "desc" }, take: 50 }));
});

export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, ExperimentSchema);
  const out = await domain(() => runExperiment({ companyId: id, ...body, createdBy: user.userId }));
  return ok(out, { status: 201 });
});
