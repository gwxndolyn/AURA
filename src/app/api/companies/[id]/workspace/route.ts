import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const ws = await prisma.codeWorkspace.findFirst({ where: { companyId: id } });
  const files = ws ? parseJSON<Record<string, string>>(ws.files, {}) : {};
  const recentChanges = await prisma.simulationEvent.findMany({
    where: { companyId: id, type: "CODE_CHANGED" },
    orderBy: { createdAt: "desc" },
    take: 15,
  });
  return ok({ name: ws?.name ?? "project", files, recentChanges });
});
