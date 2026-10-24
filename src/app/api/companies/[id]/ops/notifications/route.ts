import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "VIEWER");
  const rows = await prisma.notification.findMany({ where: { companyId: id }, orderBy: { createdAt: "desc" }, take: 30 });
  const items = rows.map(({ readBy, ...n }) => ({ ...n, read: parseJSON<string[]>(readBy, []).includes(user.userId) }));
  return ok({ items, unread: items.filter((n) => !n.read).length });
});

const Schema = z.object({ ids: z.array(z.string()).max(50) });

/** Mark notifications read for the current user (scoped to this workspace). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "VIEWER");
  const { ids } = await parseBody(req, Schema);
  const rows = await prisma.notification.findMany({ where: { companyId: id, id: { in: ids } } });
  for (const n of rows) {
    const read = parseJSON<string[]>(n.readBy, []);
    if (!read.includes(user.userId)) await prisma.notification.update({ where: { id: n.id }, data: { readBy: JSON.stringify([...read, user.userId].slice(-100)) } });
  }
  return ok({ marked: rows.length });
});
