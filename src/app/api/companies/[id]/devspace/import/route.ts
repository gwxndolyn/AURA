import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { seedProjectFromFixture } from "@/lib/devspace/changes";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({ template: z.enum(["checkout-validation", "checkout-fix"]) });

/** Import a deterministic sample project (adds missing files only; never overwrites). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const { template } = await parseBody(req, Schema);
  return ok(await seedProjectFromFixture(id, template, user.email));
});
