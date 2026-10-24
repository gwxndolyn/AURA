import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { labOverview, verifyState, setLoopStatus, proposeBacklog } from "@/lib/lab/lab";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Lab state (verified against persisted runs/experiments on every read), runs, experiments. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const v = await verifyState(id);
  return ok({ ...(await labOverview(id)), verification: v.fixes });
});

/** Loop control (ADMIN): pause / resume the improvement loop, or refresh the evidence-ranked backlog. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const { action } = await parseBody(req, z.object({ action: z.enum(["pause", "resume", "backlog"]) }));
  if (action === "backlog") return ok(await proposeBacklog(id));
  return ok(await setLoopStatus(id, action, user.email));
});
