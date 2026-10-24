import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { promoteVersion } from "@/lib/intelligence/experiments";
import { domain } from "../_shared";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

const PromoteSchema = z.object({
  candidateVersionId: z.string().min(1).max(40),
  waiveSoftGates: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});

/**
 * Production prompt change → ADMIN approval required. Waiving soft (cost/
 * latency) gates requires OWNER. Hard gates (correctness, security, validity,
 * regressions) can never be waived.
 */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, PromoteSchema);
  const { user } = await requireWorkspaceAccess(id, body.waiveSoftGates ? "OWNER" : "ADMIN");
  const result = await domain(() => promoteVersion({ companyId: id, ...body, actor: user.userId }));
  return ok(result, { status: result.promoted ? 200 : 409 });
});
