import { z } from "zod";
import { ok, parseBody, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { decideApproval } from "@/lib/missions/engine";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; missionId: string; approvalId: string }> };

const Schema = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(500).optional() });

/**
 * Human decision on an approval gate. Requires ADMIN: approving marks a
 * customer-facing change as ready to release. The engine re-verifies the
 * change hash before recording approval.
 */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, missionId, approvalId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const body = await parseBody(req, Schema);
  // IDOR guard: the approval must belong to this mission in this workspace.
  const a = await prisma.missionApproval.findFirst({ where: { id: approvalId, missionId, companyId: id }, select: { id: true } });
  if (!a) throw new ApiError("Approval not found", 404);
  await decideApproval(a.id, id, body.decision, user.email, body.note ?? "");
  return ok({ decided: body.decision });
});
