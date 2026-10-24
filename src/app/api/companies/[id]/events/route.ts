import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const url = new URL(req.url);
  const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 50));
  const events = await prisma.simulationEvent.findMany({
    where: { companyId: id },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return ok(events);
});
