import { z } from "zod";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { decideProductApproval } from "@/lib/factory/release";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string; approvalId: string }> };

/**
 * Decide an approval. Scope/release: MEMBER+. External publication and
 * production: ADMIN+. The requester's role is checked server-side per class.
 */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId, approvalId } = await ctx.params;
  const a = await prisma.productApproval.findFirst({ where: { id: approvalId, companyId: id, productId } });
  const minRole = a && ["external_publication", "infrastructure", "production"].includes(a.actionClass) ? "ADMIN" : "MEMBER";
  const { user } = await requireWorkspaceAccess(id, minRole);
  if (!a) throw new ApiError("Approval not found", 404);
  const b = await parseBody(req, z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(500).optional() }));
  return ok(await decideProductApproval(id, productId, approvalId, user.email, b.decision, b.note));
});
