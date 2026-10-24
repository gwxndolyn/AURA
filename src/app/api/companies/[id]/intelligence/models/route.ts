import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/events/emit";
import { MODELS, aiMode } from "@/lib/ai/claude";
import { routingDecisions } from "@/lib/intelligence/insights";
import { DEFAULT_ROUTING_POLICY } from "@/lib/intelligence/routing";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const PolicySchema = z
  .object({
    minCorrectness: z.number().min(0.5).max(1).optional(),
    minSecurity: z.number().min(0.9).max(1).optional(),
    minStructuredValidity: z.number().min(0.5).max(1).optional(),
    minSampleSize: z.number().int().min(3).max(500).optional(),
    correctnessTieEpsilon: z.number().min(0).max(0.1).optional(),
    safeDefaultTier: z.enum(["STANDARD", "REASONING"]).optional(),
    securitySensitive: z.array(z.string().min(1).max(60)).max(30).optional(),
  })
  .strict();

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const r = await routingDecisions(id);
  return ok({ ...r, models: MODELS, mode: aiMode(), defaults: DEFAULT_ROUTING_POLICY });
});

/**
 * Update the workspace routing policy (ADMIN). The security floor for
 * security-sensitive categories is fixed at 1.0 and cannot be lowered, and the
 * default security-sensitive categories can be extended but never removed.
 */
export const PUT = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const body = await parseBody(req, PolicySchema);
  const policy = {
    ...body,
    securitySensitive: [...new Set([...DEFAULT_ROUTING_POLICY.securitySensitive, ...(body.securitySensitive ?? [])])],
    securitySensitiveMinSecurity: DEFAULT_ROUTING_POLICY.securitySensitiveMinSecurity,
  };
  const row = await prisma.routingPolicyConfig.upsert({
    where: { companyId: id },
    create: { companyId: id, policy: JSON.stringify(policy), updatedBy: user.userId },
    update: { policy: JSON.stringify(policy), updatedBy: user.userId },
  });
  await audit(id, user.userId, "ROUTING_POLICY_UPDATED", row.id, JSON.stringify(policy).slice(0, 500));
  return ok(row);
});
