import { z } from "zod";
import { ok, parseBody, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { setStatus, verifyIntegrity } from "@/lib/intelligence/registry";
import { domain } from "../../../_shared";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; versionId: string }> };

const StatusSchema = z.object({ status: z.enum(["DRAFT", "EVALUATING", "APPROVED", "DEPRECATED"]) });

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, versionId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const v = await prisma.promptVersion.findFirst({ where: { id: versionId, companyId: id }, include: { template: true } });
  if (!v) throw new ApiError("Prompt version not found", 404);
  const evaluations = await prisma.evaluation.findMany({ where: { companyId: id, promptVersionId: v.id }, orderBy: { startedAt: "desc" }, take: 20 });
  return ok({ ...v, integrity: verifyIntegrity(v), evaluations });
});

/**
 * Status-only lifecycle changes. APPROVED requires ADMIN (it makes a version
 * promotable); ACTIVE/ROLLED_BACK are only reachable via /promote and /rollback.
 */
export const PATCH = handler(async (req, ctx: Ctx) => {
  const { id, versionId } = await ctx.params;
  const { status } = await parseBody(req, StatusSchema);
  const { user } = await requireWorkspaceAccess(id, status === "APPROVED" ? "ADMIN" : "MEMBER");
  return ok(await domain(() => setStatus(id, versionId, status, user.userId)));
});
