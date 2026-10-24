import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { computeSecurityScore } from "@/lib/company/security";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const [findings, security] = await Promise.all([
    prisma.securityFinding.findMany({ where: { companyId: id }, orderBy: { createdAt: "desc" } }),
    computeSecurityScore(id),
  ]);
  return ok({ findings, security });
});
