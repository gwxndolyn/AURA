import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { SCENARIOS } from "@/lib/twin/scenarios";
import { RULES_VERSION, CAPACITY_LIMITS } from "@/lib/twin/engine";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Scenario library (documented initial conditions; success-check functions are server-side). */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  return ok({
    rulesVersion: RULES_VERSION,
    capacityLimits: CAPACITY_LIMITS,
    scenarios: Object.values(SCENARIOS).map((s) => ({ id: s.id, title: s.title, situation: s.situation, objectives: s.objectives, actions: s.actions, constraints: s.constraints, successCriteria: s.successCriteria.map((c) => ({ id: c.id, text: c.text })), seed: s.seed, initial: s.initial, defaults: s.defaults })),
  });
});
