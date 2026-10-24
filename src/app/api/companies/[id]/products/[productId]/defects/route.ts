import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { loadProduct } from "@/lib/factory/store";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/** Defects observed by engine checks, with the failing and (when fixed) the passing command run. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  await loadProduct(id, productId);
  const rows = await prisma.defect.findMany({ where: { companyId: id, productId }, orderBy: { createdAt: "desc" }, take: 200 });
  return ok(rows.map((d) => ({ ...d, failingTests: parseJSON<string[]>(d.failingTests, []), files: parseJSON<string[]>(d.files, []) })));
});
