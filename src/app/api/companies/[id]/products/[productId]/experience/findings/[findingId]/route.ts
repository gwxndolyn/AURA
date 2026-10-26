import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { createTaskFromFinding, setFindingStatus } from "@/lib/experience/service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string; findingId: string }> };

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_task") }),
  z.object({ action: z.enum(["accept_risk", "dismiss", "reopen"]), note: z.string().trim().max(500).default("") }),
]);

/**
 * Act on a finding. create_task: one backlog task through the normal
 * scheduler/builder (risk policy decides who may: sensitive / shared /
 * navigation changes need an admin; hypotheses are never auto-tasked).
 * accept_risk / dismiss need an admin; critical findings cannot be dismissed.
 */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId, findingId } = await ctx.params;
  const body = await parseBody(req, Body);
  if (body.action === "create_task") {
    const { user, role } = await requirePermission(id, "execution.start");
    return ok(await createTaskFromFinding(id, productId, findingId, { email: user.email, role }), { status: 201 });
  }
  const { user } = body.action === "reopen" ? await requirePermission(id, "execution.start") : await requirePermission(id, "workspace.settings");
  await setFindingStatus(id, productId, findingId, user.email, body.action === "accept_risk" ? "ACCEPTED_RISK" : body.action === "dismiss" ? "DISMISSED" : "OPEN", body.note);
  return ok({ status: "updated" });
});
