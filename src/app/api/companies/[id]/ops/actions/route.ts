import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Action audit trail: who/what initiated, the policy clause, the decision and the real result. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const rows = await prisma.opsAction.findMany({ where: { companyId: id }, orderBy: { createdAt: "desc" }, take: 100 });
  return ok(rows.map((a) => ({ ...a, target: parseJSON(a.target, {}), result: parseJSON(a.result, {}) })));
});
