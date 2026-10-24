import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { readiness, createReleaseCandidate, requestPublish, requestDeployment } from "@/lib/factory/release";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  return ok(await readiness(id, productId));
});

/** candidate: build + re-test the integration branch. publish / deploy: create an approval request (nothing runs yet). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { action } = await parseBody(req, z.object({ action: z.enum(["candidate", "publish", "deploy"]) }));
  const { user } = await requireWorkspaceAccess(id, action === "candidate" ? "MEMBER" : "ADMIN");
  if (action === "candidate") return ok(await createReleaseCandidate(id, productId, user.email), { status: 201 });
  if (action === "publish") return ok(await requestPublish(id, productId), { status: 201 });
  return ok(await requestDeployment(id, productId), { status: 201 });
});
