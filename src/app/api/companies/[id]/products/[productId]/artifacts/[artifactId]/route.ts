import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { reviewArtifact } from "@/lib/factory/artifacts";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string; artifactId: string }> };

/** Review a design/architecture artifact: approve (creates the handoff) or request a revision with feedback. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId, artifactId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const b = await parseBody(req, z.object({ decision: z.enum(["approve", "revise"]), feedback: z.string().max(1000).optional() }));
  return ok(await reviewArtifact(id, productId, artifactId, user.email, b.decision, b.feedback));
});
