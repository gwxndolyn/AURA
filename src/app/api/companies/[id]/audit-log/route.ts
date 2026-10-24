import { ok, handler } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { AUDIT_CATEGORIES } from "@/lib/events/emit";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Workspace audit trail (audit.read, ADMIN+). ?category=&outcome=&before=<iso> (pagination). Read-only. */
export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requirePermission(id, "audit.read");
  const u = new URL(req.url);
  const category = u.searchParams.get("category");
  const outcome = u.searchParams.get("outcome");
  const before = u.searchParams.get("before");
  const beforeDate = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : undefined;
  const rows = await prisma.auditLog.findMany({
    where: { companyId: id, ...(category && (AUDIT_CATEGORIES as readonly string[]).includes(category) ? { category } : {}), ...(outcome && ["success", "denied", "failure"].includes(outcome) ? { outcome } : {}), ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, actor: true, action: true, target: true, result: true, category: true, outcome: true, createdAt: true },
  });
  return ok({ entries: rows, categories: AUDIT_CATEGORIES, next: rows.length === 100 ? rows[rows.length - 1].createdAt : null });
});
