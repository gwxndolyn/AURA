import { z } from "zod";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { runScenario, discardUnsaved } from "@/lib/twin/runs";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const scenario = new URL(req.url).searchParams.get("scenario") ?? undefined;
  const rows = await prisma.twinRun.findMany({ where: { companyId: id, ...(scenario ? { scenario } : {}) }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, scenario: true, kind: true, baselineId: true, label: true, rulesVersion: true, seed: true, inputs: true, inputHash: true, resultHash: true, saved: true, createdBy: true, createdAt: true, result: true } });
  return ok(rows.map(({ result, inputs, ...r }) => {
    const res = parseJSON<{ metrics?: Record<string, number>; criteria?: { id: string; met: boolean }[]; composite?: { score: number } }>(result, {});
    return { ...r, inputs: parseJSON(inputs, {}), metrics: res.metrics, criteria: res.criteria, composite: res.composite?.score };
  }));
});

const Decisions = z.object({
  allocation: z.object({ feature: z.number(), quality: z.number(), reliability: z.number(), security: z.number() }),
  priorities: z.array(z.enum(["ship_feature", "fix_reliability", "resolve_security", "reduce_cost"])).length(4),
  capacity: z.object({ engineering: z.number().int().optional(), qa: z.number().int().optional(), infra: z.number().int().optional(), security: z.number().int().optional() }).optional(),
  verificationGate: z.boolean(),
  riskPolicy: z.enum(["cautious", "balanced", "aggressive"]),
  useRollback: z.boolean().optional(),
});
const Run = z.object({ scenario: z.enum(["delivery_crunch", "reliability_crisis", "security_growth"]), kind: z.enum(["baseline", "what_if"]), baselineId: z.string().max(40).optional(), label: z.string().max(80).optional(), decisions: Decisions });

/** Run a simulation (baseline or isolated what-if). MEMBER+; rate-limited; never touches live state. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, Run);
  return ok(await runScenario({ companyId: id, actor: user.email, ...body }), { status: 201 });
});

/** Discard unsaved runs of a scenario (this workspace only). */
export const DELETE = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const parsed = z.enum(["delivery_crunch", "reliability_crisis", "security_growth"]).safeParse(new URL(req.url).searchParams.get("scenario"));
  if (!parsed.success) throw new ApiError("Unknown scenario", 422);
  const scenario = parsed.data;
  return ok(await discardUnsaved(id, scenario, user.email));
});
