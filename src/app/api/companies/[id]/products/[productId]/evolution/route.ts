import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { z } from "zod";
import { parseBody } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { versionState, addRequest, collectProposals } from "@/lib/factory/maintenance";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/** Product evolution: version state, prioritized proposals, maintenance cycles. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { role } = await requireWorkspaceAccess(id, "VIEWER");
  const [state, proposals, cycles] = await Promise.all([
    versionState(id, productId),
    prisma.improvementProposal.findMany({ where: { companyId: id, productId }, orderBy: [{ mandatory: "desc" }, { priority: "desc" }, { updatedAt: "desc" }], take: 100 }),
    prisma.maintenanceCycle.findMany({ where: { companyId: id, productId }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  const product = await prisma.product.findFirstOrThrow({ where: { id: productId, companyId: id }, select: { maintenanceMode: true, maintenanceBudget: true } });
  return ok({
    state, role, mode: product.maintenanceMode, budget: parseJSON(product.maintenanceBudget, {}),
    proposals: proposals.map((p) => ({ ...p, evidence: parseJSON(p.evidence, []), components: parseJSON(p.components, []), requirements: parseJSON(p.requirements, []), verification: parseJSON(p.verification, []), priorityWhy: parseJSON(p.priorityWhy, []), outcome: parseJSON(p.outcome, {}) })),
    cycles: cycles.map((c) => ({ ...c, checkpoint: parseJSON(c.checkpoint, {}) })),
  });
});

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request"), title: z.string().min(3).max(200), problem: z.string().min(3).max(2000), components: z.array(z.string().max(200)).max(10).optional() }),
  z.object({ action: z.literal("analyze") }),
]);

/** request: file your own improvement · analyze: re-collect evidence-backed proposals now (read-only analysis). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requirePermission(id, "source.change");
  const b = await parseBody(req, Body);
  if (b.action === "analyze") return ok(await collectProposals(id, productId));
  return ok(await addRequest(id, productId, user.email, b), { status: 201 });
});
