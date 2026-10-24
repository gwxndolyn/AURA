import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { runCheck } from "@/lib/devspace/checks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  return ok(await prisma.execRun.findMany({ where: { companyId: id }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, check: true, command: true, revision: true, changeId: true, status: true, mode: true, exitCode: true, passed: true, failed: true, total: true, failedNames: true, truncated: true, requestedBy: true, startedAt: true, completedAt: true, createdAt: true } }));
});

// Only allowlisted check ids — never a command string.
const Schema = z.object({ check: z.enum(["unit-tests", "syntax", "lint", "typecheck", "build"]), changeId: z.string().max(40).optional() });

export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, Schema);
  return ok(await runCheck(id, body.check, user.email, { changeId: body.changeId }));
});
