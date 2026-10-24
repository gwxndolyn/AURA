import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/events/emit";
import { loadProduct } from "@/lib/factory/store";
import { MAINTENANCE_MODES, budgetOf } from "@/lib/factory/maintenance";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

const Schema = z.object({ mode: z.enum(MAINTENANCE_MODES).optional(), budget: z.object({ maxConcurrent: z.number().int(), maxAttemptsPerIssue: z.number().int(), maxChangesPerCycle: z.number().int(), maxCycleMs: z.number().int(), maxUnreviewed: z.number().int() }).partial().optional() });

/** Maintenance autonomy mode + budgets (ADMIN). Enforced by the maintenance cycle, not the UI. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requirePermission(id, "workspace.settings");
  const p = await loadProduct(id, productId);
  const b = await parseBody(req, Schema);
  const budget = budgetOf({ maintenanceBudget: JSON.stringify({ ...JSON.parse(p.maintenanceBudget || "{}"), ...(b.budget ?? {}) }) });
  const r = await prisma.product.update({ where: { id: p.id }, data: { ...(b.mode ? { maintenanceMode: b.mode } : {}), maintenanceBudget: JSON.stringify(budget) }, select: { maintenanceMode: true, maintenanceBudget: true } });
  await audit(id, user.email, "MAINTENANCE_POLICY_CHANGED", productId, `${p.maintenanceMode} → ${r.maintenanceMode}; ${r.maintenanceBudget}`);
  return ok({ mode: r.maintenanceMode, budget });
});
