import { prisma } from "@/lib/db";
import { getSession } from "./session";
import { log } from "@/lib/observability/log";

/** A member tried something their role does not allow: audited (category security, outcome denied). */
async function recordDenied(companyId: string, actor: string, detail: string) {
  log("warn", "authz.denied", { companyId, actor, detail });
  await prisma.auditLog.create({ data: { companyId, actor, action: "ACCESS_DENIED", target: companyId, result: detail, category: "security", outcome: "denied" } }).catch(() => null);
}

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
export const WORKSPACE_ROLES = ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * Named permissions → minimum role. Routes and services ask for a permission,
 * not a rank, so the model is explicit and testable (src/lib/auth/permissions.test.ts).
 * MEMBER is the "developer" role: it may run and change code but not manage
 * people, money, integrations, secrets or production.
 */
export const PERMISSIONS = {
  "workspace.read": "VIEWER",
  "artifact.download": "VIEWER",
  "usage.read": "VIEWER",
  "execution.start": "MEMBER",
  "execution.cancel": "MEMBER",
  "source.change": "MEMBER",
  "deploy.preview": "MEMBER",
  "deploy.production": "ADMIN",
  "integration.manage": "ADMIN",
  "secret.manage": "ADMIN",
  "member.manage": "ADMIN",
  "billing.manage": "ADMIN",
  "audit.read": "ADMIN",
  "data.export": "ADMIN",
  "product.archive": "ADMIN",
  "workspace.settings": "ADMIN",
  "workspace.delete": "OWNER",
  "ownership.transfer": "OWNER",
} as const satisfies Record<string, WorkspaceRole>;
export type Permission = keyof typeof PERMISSIONS;

export function roleAllows(role: string, permission: Permission): boolean {
  return (ROLE_RANK[role] ?? -1) >= ROLE_RANK[PERMISSIONS[permission]];
}

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
  if (!role) {
    // Non-member: log for abuse detection (never written into that tenant's audit — nothing about it is revealed).
    log("warn", "authz.cross_tenant_denied", { userId: user.userId, companyId });
    throw new AuthError(404, "Workspace not found"); // deny + don't leak
  }

  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    await recordDenied(companyId, user.email, `requires ${minRole}, has ${role}`);
    throw new AuthError(403, `Requires ${minRole} role`);
  }
  return { user, role };
}

/** requireWorkspaceAccess by named permission (see PERMISSIONS). */
export async function requirePermission(companyId: string, permission: Permission) {
  const r = await requireWorkspaceAccess(companyId, "VIEWER");
  if (!roleAllows(r.role, permission)) {
    await recordDenied(companyId, r.user.email, `${permission} needs ${PERMISSIONS[permission]}, has ${r.role}`);
    throw new AuthError(403, `Your role (${r.role.toLowerCase()}) does not allow ${permission.replace(".", " ")}`);
  }
  return r;
}

/** Platform operator check (separate from tenant roles; every use is recorded in PlatformAudit by the caller). */
export async function requirePlatformAdmin(): Promise<AuthedUser> {
  const user = await requireUser();
  const u = await prisma.user.findUnique({ where: { id: user.userId }, select: { isPlatformAdmin: true } });
  if (!u?.isPlatformAdmin) throw new AuthError(404, "Not found");
  return user;
}

/** List company ids the user may access (owned or member of). */
export async function accessibleCompanyIds(userId: string): Promise<string[]> {
  const [owned, memberships] = await Promise.all([
    prisma.company.findMany({ where: { ownerId: userId }, select: { id: true } }),
    prisma.workspaceMember.findMany({ where: { userId }, select: { companyId: true } }),
  ]);
  return Array.from(new Set([...owned.map((c) => c.id), ...memberships.map((m) => m.companyId)]));
}
