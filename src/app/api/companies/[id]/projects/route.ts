import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const projects = await prisma.project.findMany({
    where: { companyId: id },
    orderBy: { createdAt: "desc" },
    include: { tasks: { select: { status: true } } },
  });
  return ok(projects);
});

const Schema = z.object({ name: z.string().min(1).max(80), description: z.string().max(300).default("") });

export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, Schema);
  const project = await prisma.project.create({
    data: { companyId: id, name: body.name, description: body.description },
  });
  return ok(project, { status: 201 });
});
