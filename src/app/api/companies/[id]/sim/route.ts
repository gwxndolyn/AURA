import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { advanceDays } from "@/lib/company/simulation";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({
  action: z.enum(["play", "pause", "step", "setSpeed"]),
  speed: z.number().int().min(1).max(10).optional(),
  days: z.number().int().min(1).max(30).optional(),
});

/**
 * Simulation control. The simulation advances via explicit ticks (step/advance)
 * driven by the client's play loop or a manual step, keeping it serverless-safe.
 */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, Schema);

  if (body.action === "play") {
    await prisma.company.update({ where: { id }, data: { simRunning: true, simSpeed: body.speed ?? 1 } });
  } else if (body.action === "pause") {
    await prisma.company.update({ where: { id }, data: { simRunning: false } });
  } else if (body.action === "setSpeed") {
    await prisma.company.update({ where: { id }, data: { simSpeed: body.speed ?? 1 } });
  } else if (body.action === "step") {
    await advanceDays(id, body.days ?? 1);
  }

  const company = await prisma.company.findUnique({
    where: { id },
    select: { simDay: true, simRunning: true, simSpeed: true },
  });
  return ok(company);
});
