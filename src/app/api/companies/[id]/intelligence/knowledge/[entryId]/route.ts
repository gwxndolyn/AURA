import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { reviewKnowledge } from "@/lib/intelligence/knowledge";
import { domain } from "../../_shared";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; entryId: string }> };

const ReviewSchema = z.object({
  action: z.enum(["approve", "reject", "deprecate", "edit"]),
  note: z.string().max(500).optional(),
  edit: z
    .object({ title: z.string().min(3).max(200).optional(), lesson: z.string().min(3).max(2000).optional(), confidence: z.enum(["low", "medium", "high"]).optional() })
    .strict()
    .optional(),
});

/** Approving/editing shared knowledge requires ADMIN (it shapes agent/dev guidance). */
export const PATCH = handler(async (req, ctx: Ctx) => {
  const { id, entryId } = await ctx.params;
  const body = await parseBody(req, ReviewSchema);
  const { user } = await requireWorkspaceAccess(id, body.action === "reject" ? "MEMBER" : "ADMIN");
  return ok(await domain(() => reviewKnowledge({ companyId: id, id: entryId, action: body.action, reviewer: user.userId, note: body.note, edit: body.edit })));
});

export const DELETE = handler(async (_req, ctx: Ctx) => {
  const { id, entryId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  return ok(await domain(() => reviewKnowledge({ companyId: id, id: entryId, action: "delete", reviewer: user.userId })));
});
