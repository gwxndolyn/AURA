import { z } from "zod";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { ACTION_TYPES, executeAction, recommendationsFor, ActionError } from "@/lib/ops/actions";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string; findingId: string }> };

const Schema = z.object({ action: z.enum(ACTION_TYPES) });

/**
 * Run a recommended action for a finding. The target is taken from the
 * server-side recommendation (never from the client), so a user cannot point
 * an action at an arbitrary resource. Policy decides; the result is recorded.
 */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, findingId } = await ctx.params;
  const { user, role } = await requireWorkspaceAccess(id, "MEMBER");
  const { action } = await parseBody(req, Schema);
  const f = await prisma.opsFinding.findFirst({ where: { id: findingId, companyId: id } });
  if (!f) throw new ApiError("Finding not found", 404);
  const rec = (await recommendationsFor(f)).find((r) => r.action === action);
  if (!rec) throw new ApiError(`"${action}" is not a recommended action for this finding`, 422);
  if (rec.unavailable) throw new ApiError(rec.unavailable, 409);
  try {
    const r = await executeAction({ companyId: id, action, target: rec.target, findingId: f.id, actor: user.email, role, trigger: "user" });
    return ok({ ...r.action, result: JSON.parse(r.action.result), target: JSON.parse(r.action.target), policy: r.decision }, { status: r.decision.decision === "allowed" ? 200 : 403 });
  } catch (e) {
    if (e instanceof ActionError) throw new ApiError(e.message, e.status);
    throw e;
  }
});
