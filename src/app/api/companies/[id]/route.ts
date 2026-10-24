import { ok, err, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await (ctx.params as Promise<{ id: string }>);
  await requireWorkspaceAccess(id, "VIEWER");
  const company = await prisma.company.findUnique({ where: { id } });
  if (!company) return err("Company not found", 404);
  return ok(company);
});

export const DELETE = handler(async (_req, ctx: Ctx) => {
  const { id } = await (ctx.params as Promise<{ id: string }>);
  await requireWorkspaceAccess(id, "OWNER"); // only the owner may delete a workspace
  await prisma.company.delete({ where: { id } });
  return ok({ deleted: true });
});
