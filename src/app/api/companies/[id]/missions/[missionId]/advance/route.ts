import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { advanceMission, runUntilBlocked } from "@/lib/missions/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string; missionId: string }> };

const Schema = z.object({ steps: z.number().int().min(1).max(5).default(1) });

/**
 * Execute up to `steps` bounded engine steps (each claims at most one task
 * under a lease). The client calls this repeatedly; progress survives refresh
 * because all state lives in the database.
 */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, missionId } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const { steps } = await parseBody(req, Schema);
  return ok(steps === 1 ? await advanceMission(missionId, id) : await runUntilBlocked(missionId, id, steps));
});
