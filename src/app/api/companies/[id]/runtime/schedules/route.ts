import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { createSchedule } from "@/lib/runtime/schedule";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Job types that may be scheduled from the API (others are internal). */
const SCHEDULABLE = ["lab.cycle", "runtime.ping"] as const;

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  return ok(await prisma.schedule.findMany({ where: { companyId: id }, orderBy: { createdAt: "desc" } }));
});

/** ADMIN: schedule recurring self-improvement cycles (or pings). Goals are scheduled via POST goals {schedule}. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const b = await parseBody(req, z.object({ name: z.string().min(2).max(120), jobType: z.enum(SCHEDULABLE), spec: z.string().min(3).max(80) }));
  return ok(await createSchedule({ companyId: id, name: b.name, jobType: b.jobType, payload: {}, spec: b.spec, createdBy: user.email }), { status: 201 });
});
