import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { startProjectMission } from "@/lib/devspace/changes";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({ objective: z.string().min(10).max(2000) });

/** Start a mission on the project's current revision (planned; waits for plan approval). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const { objective } = await parseBody(req, Schema);
  return ok(await startProjectMission(id, user.userId, objective), { status: 201 });
});
