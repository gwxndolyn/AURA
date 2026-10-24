import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { getConfig, updateConfig, previewImpact, decisionsFromConfig } from "@/lib/twin/config";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const Alloc = z.object({ feature: z.number().min(0).max(1), quality: z.number().min(0).max(1), reliability: z.number().min(0).max(1), security: z.number().min(0).max(1) });
const Prio = z.array(z.enum(["ship_feature", "fix_reliability", "resolve_security", "reduce_cost"])).length(4);
const Cap = z.object({ engineering: z.number().int().optional(), qa: z.number().int().optional(), infra: z.number().int().optional(), security: z.number().int().optional() });
const Patch = z.object({ allocation: Alloc.optional(), priorities: Prio.optional(), capacity: Cap.optional(), riskPolicy: z.enum(["cautious", "balanced", "aggressive"]).optional(), budgetUsd: z.number().min(1000).max(10_000_000).optional(), objectives: z.array(z.string().min(3).max(200)).max(6).optional() });

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  return ok(await getConfig(id));
});

/** Preview a decision's simulated impact on a scenario (nothing saved). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const body = await parseBody(req, z.object({ scenario: z.string().max(40), patch: Patch }));
  const cur = decisionsFromConfig(await getConfig(id));
  return ok(previewImpact(body.scenario, cur, { ...cur, ...body.patch, capacity: body.patch.capacity ?? cur.capacity }));
});

/** Apply a CEO decision (simulated company configuration). ADMIN+; optimistic concurrency via version. */
export const PUT = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const body = await parseBody(req, Patch.extend({ expectedVersion: z.number().int().min(1) }));
  const { expectedVersion, ...patch } = body;
  return ok(await updateConfig(id, user.email, patch, expectedVersion));
});
