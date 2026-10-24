import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { linkRepo, prStatus } from "@/lib/integrations/github/service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/** Link the product to a GitHub repository (import its code, or publish AURA's repo there). ADMIN+. */
export const PUT = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const b = await parseBody(req, z.object({ fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/), mode: z.enum(["import", "publish"]) }));
  return ok(await linkRepo(id, productId, user.email, b));
});

/** Real pull request state + check runs from GitHub (?pr=<number>). */
export const GET = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const n = Number(new URL(req.url).searchParams.get("pr"));
  return ok(await prStatus(id, productId, n));
});
