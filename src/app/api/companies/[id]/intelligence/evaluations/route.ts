import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { MODEL_TIERS } from "@/lib/types";
import { AGENT_DEFS } from "@/lib/agents/definitions";
import { runEvaluation } from "@/lib/intelligence/evaluation";
import { domain } from "../_shared";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

const AGENT_KEYS = AGENT_DEFS.map((d) => d.key) as [string, ...string[]];
const RunSchema = z.object({
  agentKey: z.enum(AGENT_KEYS),
  datasetId: z.string().min(1).max(60),
  promptVersionId: z.string().min(1).max(40).optional(),
  tier: z.enum(MODEL_TIERS).optional(),
});

export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const agentKey = new URL(req.url).searchParams.get("agentKey") ?? undefined;
  const rows = await prisma.evaluation.findMany({
    where: { companyId: id, ...(agentKey ? { agentKey } : {}) },
    orderBy: { startedAt: "desc" },
    take: 100,
  });
  return ok(rows);
});

export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, RunSchema);
  const out = await domain(() => runEvaluation({ companyId: id, ...body, label: "adhoc", createdBy: user.userId }));
  return ok({ evaluationId: out.evaluationId, status: out.status, stopReason: out.stopReason, run: out.run }, { status: 201 });
});
