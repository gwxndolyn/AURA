import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Engineering runs in this workspace (optionally ?product=). */
export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const product = new URL(req.url).searchParams.get("product") ?? undefined;
  const rows = await prisma.build.findMany({ where: { companyId: id, ...(product ? { productId: product } : {}) }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, productId: true, itemKey: true, status: true, phase: true, branch: true, headSha: true, attempt: true, maxRepairs: true, costUsd: true, tokensIn: true, tokensOut: true, sandboxMs: true, failure: true, createdAt: true, finishedAt: true } });
  return ok(rows);
});
