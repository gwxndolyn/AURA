import { ok, handler } from "@/lib/api";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Returns the current user + accessible workspaces, or {user:null} if signed out. */
export const GET = handler(async () => {
  const session = await getSession();
  if (!session) return ok({ user: null, workspaces: [] });

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, name: true },
  });
  if (!user) return ok({ user: null, workspaces: [] });

  const [owned, memberships] = await Promise.all([
    prisma.company.findMany({ where: { ownerId: user.id }, select: { id: true, name: true, status: true } }),
    prisma.workspaceMember.findMany({
      where: { userId: user.id },
      select: { role: true, company: { select: { id: true, name: true, status: true } } },
    }),
  ]);

  const map = new Map<string, { id: string; name: string; status: string; role: string }>();
  for (const c of owned) map.set(c.id, { ...c, role: "OWNER" });
  for (const m of memberships) if (!map.has(m.company.id)) map.set(m.company.id, { ...m.company, role: m.role });

  return ok({ user, workspaces: Array.from(map.values()) });
});
