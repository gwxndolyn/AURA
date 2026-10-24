import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { createMission, planMission } from "@/lib/missions/engine";
import { EXAMPLE_OBJECTIVE } from "@/lib/demo/service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * "Run example mission": creates YOUR OWN copy of the showcase checkout-fix
 * mission (source EXAMPLE) and plans it. It never touches the read-only sample
 * missions. Execution still waits for you to approve the plan.
 */
export const POST = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const m = await createMission({ companyId: id, createdById: user.userId, objective: EXAMPLE_OBJECTIVE, title: "Fix the one-cent checkout undercharge", source: "EXAMPLE" });
  await planMission(m.id, id);
  return ok({ id: m.id }, { status: 201 });
});
