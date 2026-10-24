import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { reviseBrief } from "@/lib/factory/store";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

const Revise = z.object({ expectedVersion: z.number().int(), content: z.unknown(), note: z.string().max(500).optional() });

/** Save an edited brief as a new revision (validated). Requirement changes flag affected work and re-open scope approval. */
export const PUT = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const b = await parseBody(req, Revise);
  return ok(await reviseBrief(id, productId, user.email, b.content, b.expectedVersion, b.note));
});
