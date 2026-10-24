import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { createMission, planMission } from "@/lib/missions/engine";
import { listMissions } from "@/lib/missions/read";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  return ok(await listMissions(id));
});

const CreateSchema = z.object({
  objective: z.string().min(10).max(2000),
  title: z.string().min(1).max(90).optional(),
  budgetUsd: z.number().min(0.05).max(10).optional(),
  maxRepairs: z.number().int().min(0).max(5).optional(),
  /** Tighter per-tool timeouts for this mission (ms). Only known tools; bounded server-side. */
  toolTimeouts: z.record(z.enum(["test.run", "sandbox.exec", "code.read", "code.write", "security.scan"]), z.number().int().min(10).max(60_000)).optional(),
  /** Generate the plan immediately (it still waits for human approval). */
  plan: z.boolean().default(true),
});

/** Create a mission. Planning runs one agent turn; nothing executes until the plan is approved. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, CreateSchema);
  const m = await createMission({ companyId: id, createdById: user.userId, objective: body.objective, title: body.title, budgetUsd: body.budgetUsd, maxRepairs: body.maxRepairs, toolTimeouts: body.toolTimeouts });
  if (body.plan) await planMission(m.id, id);
  return ok({ id: m.id }, { status: 201 });
});
