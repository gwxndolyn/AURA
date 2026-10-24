import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { listProducts } from "@/lib/factory/read";
import { createProduct } from "@/lib/factory/store";
import { AUTONOMY_LEVELS } from "@/lib/factory/policy";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  return ok(await listProducts(id));
});

const Create = z.object({
  idea: z.string().min(20).max(4000),
  autonomy: z.enum(AUTONOMY_LEVELS).optional(),
  limits: z.object({ maxRepairs: z.number(), maxParallel: z.number(), budgetUsd: z.number(), maxAttempts: z.number(), projectBudgetUsd: z.number() }).partial().optional(),
});

/** Create a product from an idea: PM brief + initial backlog + git repo + scope approval request. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, Create);
  const r = await createProduct({ companyId: id, userId: user.userId, actor: user.email, ...body });
  return ok({ id: r.product.id, jobId: r.jobId, planningStatus: r.product.planningStatus }, { status: 201 });
});
