import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { loadProduct } from "@/lib/factory/store";
import { submitChangeRequest } from "@/lib/factory/change";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  await loadProduct(id, productId);
  const rows = await prisma.productArtifact.findMany({ where: { productId, companyId: id, kind: "CHANGE_REQUEST" }, orderBy: { version: "desc" } });
  return ok(rows.map((r) => ({ ...r, content: parseJSON(r.content, {}) })));
});

/** MEMBER: request a follow-up change to the existing product (planned as targeted tasks by a durable job). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const { request } = await parseBody(req, z.object({ request: z.string().min(10).max(4000) }));
  return ok(await submitChangeRequest(id, productId, request, user.email), { status: 202 });
});
