import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { productDetail } from "@/lib/factory/read";
import { updateSettings } from "@/lib/factory/store";
import { AUTONOMY_LEVELS } from "@/lib/factory/policy";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { role } = await requireWorkspaceAccess(id, "VIEWER");
  const d = await productDetail(id, productId);
  return ok({ ...d, role });
});

const Settings = z.object({
  expectedVersion: z.number().int(),
  autonomy: z.enum(AUTONOMY_LEVELS).optional(),
  limits: z.object({ maxRepairs: z.number(), maxParallel: z.number(), budgetUsd: z.number(), maxAttempts: z.number(), projectBudgetUsd: z.number() }).partial().optional(),
});

/** Autonomy level and execution limits. ADMIN+ (they change what agents may do unattended). */
export const PATCH = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const { expectedVersion, ...rest } = await parseBody(req, Settings);
  const p = await updateSettings(id, productId, user.email, rest, expectedVersion);
  return ok({ autonomy: p.autonomy, version: p.version });
});
