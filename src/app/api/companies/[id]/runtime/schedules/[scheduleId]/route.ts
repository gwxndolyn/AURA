import { z } from "zod";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/events/emit";
import { nextRun } from "@/lib/runtime/schedule";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; scheduleId: string }> };

/** ADMIN: enable / disable / delete a schedule. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, scheduleId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const { action } = await parseBody(req, z.object({ action: z.enum(["enable", "disable", "delete"]) }));
  const s = await prisma.schedule.findFirst({ where: { id: scheduleId, companyId: id } });
  if (!s) throw new ApiError("Schedule not found", 404);
  if (action === "delete") await prisma.schedule.delete({ where: { id: s.id } });
  else await prisma.schedule.update({ where: { id: s.id }, data: { enabled: action === "enable", nextRunAt: action === "enable" ? nextRun(s.spec, new Date()) : s.nextRunAt } });
  await audit(id, user.email, "RUNTIME_SCHEDULE", s.id, action);
  return ok({ scheduleId, action });
});
