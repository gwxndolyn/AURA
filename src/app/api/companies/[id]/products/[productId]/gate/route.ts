import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { evaluateGate, setQualityProfile, deliveryReport, QUALITY_PROFILES } from "@/lib/factory/gate";
import { deliveryScorecard } from "@/lib/factory/scorecard";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/** Delivery quality gate evaluated from persisted evidence, plus the available profiles. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  return ok({ ...(await evaluateGate(id, productId)), scorecard: (await deliveryScorecard(id, productId)).metrics, profiles: Object.entries(QUALITY_PROFILES).map(([key, v]) => ({ key, ...v })) });
});

/** Change the quality profile (ADMIN+: it changes what "done" means for this product). */
export const PATCH = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const { profile } = await parseBody(req, z.object({ profile: z.enum(Object.keys(QUALITY_PROFILES) as [string, ...string[]]) }));
  return ok(await setQualityProfile(id, productId, user.email, profile));
});

/** Generate a delivery report from the recorded artifacts and verification results (MEMBER+). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  await parseBody(req, z.object({ action: z.literal("report") }));
  return ok(await deliveryReport(id, productId, user.email), { status: 201 });
});
