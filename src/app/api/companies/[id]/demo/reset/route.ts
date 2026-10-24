import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { resetDemoWorkspace } from "@/lib/demo/service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

// The client must echo the literal confirmation word — guards against accidental calls.
const Schema = z.object({ confirm: z.literal("RESET") });

/** Reset THIS demo workspace to its baseline. Owner only; non-demo workspaces are refused. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "OWNER");
  await parseBody(req, Schema);
  return ok(await resetDemoWorkspace(id, user.userId));
});
