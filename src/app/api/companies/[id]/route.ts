import { z } from "zod";
import { ok, err, handler, parseBody, ApiError } from "@/lib/api";
import { requireWorkspaceAccess, requirePermission } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/events/emit";
import { assertNoActivePaidPlan, deleteWorkspaceData } from "@/lib/lifecycle/deletion";
import { PLANS } from "@/lib/billing/plans";
import { effectivePlan } from "@/lib/billing/entitlements";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await (ctx.params as Promise<{ id: string }>);
  await requireWorkspaceAccess(id, "VIEWER");
  const company = await prisma.company.findUnique({ where: { id } });
  if (!company) return err("Company not found", 404);
  return ok(company);
});

const Patch = z.object({
  name: z.string().min(1).max(60).optional(),
  monthlyBudgetUsd: z.number().min(0).max(100_000).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
});

/** Workspace settings: name, customer spending cap (AI, USD/month), artifact retention. workspace.settings (ADMIN+). */
export const PATCH = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requirePermission(id, "workspace.settings");
  const body = await parseBody(req, Patch);
  if (body.retentionDays !== undefined) {
    const { plan } = await effectivePlan(id);
    if (body.retentionDays > plan.limits.retentionDays) throw new ApiError(`Your ${plan.name} plan keeps run output for at most ${plan.limits.retentionDays} days (Team: ${PLANS.team.limits.retentionDays})`, 402);
  }
  const before = await prisma.company.findUniqueOrThrow({ where: { id }, select: { name: true, monthlyBudgetUsd: true, retentionDays: true } });
  const c = await prisma.company.update({ where: { id }, data: body, select: { id: true, name: true, monthlyBudgetUsd: true, retentionDays: true } });
  const changes = Object.keys(body).map((k) => `${k}: ${before[k as keyof typeof before]} → ${c[k as keyof typeof c]}`).join("; ");
  await audit(id, user.email, body.monthlyBudgetUsd !== undefined ? "SPENDING_CAP_CHANGED" : body.retentionDays !== undefined ? "RETENTION_CHANGED" : "WORKSPACE_UPDATED", id, changes);
  return ok(c);
});

/**
 * Delete the workspace (owner only, name confirmation). Refused while a paid
 * plan still renews. Reports what was removed and what is retained elsewhere.
 */
export const DELETE = handler(async (req, ctx: Ctx) => {
  const { id } = await (ctx.params as Promise<{ id: string }>);
  await requirePermission(id, "workspace.delete");
  const company = await prisma.company.findUniqueOrThrow({ where: { id }, select: { name: true } });
  const body = await req.json().catch(() => ({}));
  if (body?.confirm !== undefined && body.confirm !== company.name) throw new ApiError("Type the workspace name exactly to confirm", 422);
  await assertNoActivePaidPlan([id]);
  return ok(await deleteWorkspaceData(id));
});
