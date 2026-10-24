import { z } from "zod";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { decodeRun, reviewRun, saveRun, verifyReproducible } from "@/lib/twin/runs";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; runId: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, runId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const r = await prisma.twinRun.findFirst({ where: { id: runId, companyId: id } });
  if (!r) throw new ApiError("Run not found", 404);
  const d = decodeRun(r);
  return ok({ ...d, review: reviewRun(d) });
});

const Action = z.discriminatedUnion("action", [z.object({ action: z.literal("save"), label: z.string().max(80).optional() }), z.object({ action: z.literal("verify") })]);

export const POST = handler(async (req, ctx: Ctx) => {
  const { id, runId } = await ctx.params;
  const body = await parseBody(req, Action);
  const { user } = await requireWorkspaceAccess(id, body.action === "save" ? "MEMBER" : "VIEWER");
  return ok(body.action === "save" ? await saveRun(id, runId, user.email, body.label) : await verifyReproducible(id, runId));
});
