import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { decidePlan, planMission } from "@/lib/missions/engine";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; missionId: string }> };

const Schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), note: z.string().max(500).optional() }),
  z.object({ action: z.literal("reject"), note: z.string().max(500).optional() }),
  z.object({ action: z.literal("replan"), reason: z.string().min(3).max(300) }),
]);

/**
 * Human decision on the proposed plan, or a request to replan. The decision is
 * attributed to the authenticated user — agents have no route to this.
 */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, missionId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, Schema);
  if (body.action === "replan") return ok(await planMission(missionId, id, { reason: body.reason }));
  await decidePlan(missionId, id, body.action, user.email, body.note ?? "");
  return ok({ decided: body.action });
});
