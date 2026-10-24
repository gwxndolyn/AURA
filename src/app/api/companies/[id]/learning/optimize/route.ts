import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess, requirePermission } from "@/lib/auth/authz";
import { assertFeature } from "@/lib/billing/entitlements";
import { problems, proposePromptFix, evaluateCandidate, FIX_RULES } from "@/lib/learning/optimize";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

/** Evidence-backed problems and which have a bounded prompt change available. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  return ok({ problems: (await problems(id)).map((p) => ({ ...p, fixAvailable: !!FIX_RULES[p.category] })) });
});

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("propose"), agentKey: z.string().max(40), category: z.string().max(40) }),
  z.object({ action: z.literal("evaluate"), agentKey: z.string().max(40), candidateVersionId: z.string().max(40), repetitions: z.number().int().min(1).max(5).optional() }),
]);

/**
 * propose: create a DRAFT candidate (never active). evaluate: A/B against the
 * active version with the existing harness. Promotion/rollback stay on the
 * existing /intelligence/promote and /intelligence/rollback routes (ADMIN, gates).
 */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requirePermission(id, "workspace.settings");
  await assertFeature(id, "advanced_agents");
  const b = await parseBody(req, Body);
  if (b.action === "propose") return ok(await proposePromptFix(id, b.agentKey, b.category, user.email), { status: 201 });
  return ok(await evaluateCandidate(id, b.agentKey, b.candidateVersionId, user.email, b.repetitions));
});
