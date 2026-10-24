import { prisma } from "@/lib/db";
import { getSession } from "./session";

/**
 * Authorization layer for multi-tenant access control. This is the single
 * choke-point every company-scoped API route and background job must call.
 * It denies cross-workspace access (prevents IDOR): a user can only touch a
 * company they own or are a member of.
 */

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export const ROLE_RANK: Record<string, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

export interface AuthedUser {
  userId: string;
  email: string;
}

/** Require an authenticated user or throw 401. */
export async function requireUser(): Promise<AuthedUser> {
  const session = await getSession();
  if (!session) throw new AuthError(401, "Authentication required");
  // Confirm the user still exists (handles deleted accounts with live cookies).
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true } });
  if (!user) throw new AuthError(401, "Session is no longer valid");
  return session;
}

/**
 * Require that the authenticated user has at least `minRole` on `companyId`.
 * Returns the user's effective role. Throws 401 if unauthenticated, 403/404 if
 * not a member (404 to avoid leaking existence of other workspaces).
 */
export async function requireWorkspaceAccess(
  companyId: string,
  minRole: keyof typeof ROLE_RANK = "VIEWER",
): Promise<{ user: AuthedUser; role: string }> {
  const user = await requireUser();

  const [company, membership] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { id: true, ownerId: true } }),
    prisma.workspaceMember.findUnique({
      where: { userId_companyId: { userId: user.userId, companyId } },
      select: { role: true },
    }),
  ]);

  if (!company) throw new AuthError(404, "Workspace not found");

  // Owner always has OWNER rights even without an explicit membership row.
  let role = membership?.role;
  if (!role && company.ownerId === user.userId) role = "OWNER";
  if (!role) throw new AuthError(404, "Workspace not found"); // deny + don't leak

  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw new AuthError(403, `Requires ${minRole} role`);
  }
  return { user, role };
}

/** List company ids the user may access (owned or member of). */
export async function accessibleCompanyIds(userId: string): Promise<string[]> {
  const [owned, memberships] = await Promise.all([
    prisma.company.findMany({ where: { ownerId: userId }, select: { id: true } }),
    prisma.workspaceMember.findMany({ where: { userId }, select: { companyId: true } }),
  ]);
  return Array.from(new Set([...owned.map((c) => c.id), ...memberships.map((m) => m.companyId)]));
}
