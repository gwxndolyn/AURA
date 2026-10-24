/**
 * Organization membership lifecycle: invitations, acceptance, role changes,
 * removal, leaving and ownership transfer. Every rule is enforced here, on the
 * server, from the caller's role as resolved by requireWorkspaceAccess:
 *
 * - Invitations need member.manage (ADMIN+), consume a seat (members + pending
 *   invitations ≤ plan seats), are single-use, expire after 7 days, and can
 *   only be accepted by a signed-in user whose email matches the invitation.
 * - Nobody can grant a role above their own; only the OWNER can make or
 *   demote ADMINs. OWNER is never granted by invitation or role change — only
 *   by an explicit ownership transfer by the current owner.
 * - The owner cannot be removed or leave (transfer ownership first), so a
 *   workspace always has exactly one owner.
 * - Removing a member signs nothing out globally (they keep their account)
 *   but their next request to this workspace fails (membership is checked per
 *   request by requireWorkspaceAccess).
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { audit } from "@/lib/events/emit";
import { assertCanStart } from "@/lib/billing/entitlements";
import { ROLE_RANK, type WorkspaceRole } from "./authz";
import { randomToken, sha256 } from "./password";

export const INVITABLE_ROLES = ["ADMIN", "MEMBER", "VIEWER"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];
const INVITE_TTL_MS = 7 * 24 * 3600_000;

function assertCanGrant(actorRole: string, role: string) {
  if (role === "OWNER") throw new ApiError("Ownership can only be transferred, not granted", 422);
  if (role === "ADMIN" && actorRole !== "OWNER") throw new ApiError("Only the workspace owner can grant the admin role", 403);
  if (ROLE_RANK[role] > ROLE_RANK[actorRole]) throw new ApiError("You cannot grant a role above your own", 403);
}

export async function listMembers(companyId: string) {
  const [members, invitations, company] = await Promise.all([
    prisma.workspaceMember.findMany({ where: { companyId }, orderBy: { createdAt: "asc" }, select: { userId: true, role: true, createdAt: true, user: { select: { email: true, name: true, emailVerifiedAt: true } } } }),
    prisma.invitation.findMany({ where: { companyId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, select: { id: true, email: true, role: true, expiresAt: true, createdAt: true } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { ownerId: true } }),
  ]);
  return { ownerId: company?.ownerId, members: members.map((m) => ({ userId: m.userId, role: m.role, joinedAt: m.createdAt, email: m.user.email, name: m.user.name, emailVerified: !!m.user.emailVerifiedAt })), invitations };
}

/** Create an invitation. Returns the raw token (emailed by the caller; only its hash is stored). */
export async function invite(companyId: string, actor: { userId: string; email: string; role: string }, emailRaw: string, role: InvitableRole) {
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError("Enter a valid email address", 422);
  assertCanGrant(actor.role, role);
  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existingUser && (await prisma.workspaceMember.findUnique({ where: { userId_companyId: { userId: existingUser.id, companyId } } }))) throw new ApiError("That person is already a member", 409);
  // Re-inviting the same address replaces the previous pending invitation (no seat double-count).
  await prisma.invitation.updateMany({ where: { companyId, email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  await assertCanStart(companyId, "seat");
  const rawToken = randomToken();
  const inv = await prisma.invitation.create({ data: { companyId, email, role, tokenHash: sha256(rawToken), invitedBy: actor.userId, expiresAt: new Date(Date.now() + INVITE_TTL_MS) } });
  await audit(companyId, actor.email, "MEMBER_INVITED", email, `as ${role.toLowerCase()}, expires ${inv.expiresAt.toISOString().slice(0, 10)}`);
  return { invitation: { id: inv.id, email, role, expiresAt: inv.expiresAt }, rawToken };
}

export async function revokeInvitation(companyId: string, actorEmail: string, invitationId: string) {
  const r = await prisma.invitation.updateMany({ where: { id: invitationId, companyId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!r.count) throw new ApiError("Invitation not found", 404);
  await audit(companyId, actorEmail, "INVITATION_REVOKED", invitationId, "revoked");
  return { revoked: true };
}

/** Public preview of an invitation (for the accept page). Reveals only the workspace name and role. */
export async function previewInvitation(rawToken: string) {
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(rawToken) }, include: { company: { select: { name: true } } } });
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw new ApiError("This invitation is invalid or has expired. Ask for a new one.", 404);
  return { workspace: inv.company.name, role: inv.role, email: inv.email, expiresAt: inv.expiresAt };
}

/**
 * Accept: the signed-in user's email must match the invited address (the
 * token alone is not enough — a leaked link cannot be used by someone else).
 * Single use, enforced by a conditional update.
 */
export async function acceptInvitation(rawToken: string, user: { userId: string; email: string }) {
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (!inv || inv.revokedAt || inv.expiresAt < new Date()) throw new ApiError("This invitation is invalid or has expired. Ask for a new one.", 404);
  if (inv.acceptedAt) throw new ApiError("This invitation was already used", 409);
  if (inv.email !== user.email.trim().toLowerCase()) throw new ApiError(`This invitation was sent to ${inv.email.replace(/^(.).*(@.*)$/, "$1…$2")}. Sign in with that address to accept it.`, 403);
  const claimed = await prisma.invitation.updateMany({ where: { id: inv.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: new Date(), acceptedBy: user.userId } });
  if (!claimed.count) throw new ApiError("This invitation was already used", 409);
  const existing = await prisma.workspaceMember.findUnique({ where: { userId_companyId: { userId: user.userId, companyId: inv.companyId } } });
  if (!existing) await prisma.workspaceMember.create({ data: { userId: user.userId, companyId: inv.companyId, role: inv.role } });
  // Accepting an emailed link proves the address.
  await prisma.user.updateMany({ where: { id: user.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
  await audit(inv.companyId, user.email, "MEMBER_JOINED", user.userId, `as ${inv.role.toLowerCase()} (invitation ${inv.id})`);
  return { companyId: inv.companyId, role: existing?.role ?? inv.role };
}

async function memberOf(companyId: string, userId: string) {
  const m = await prisma.workspaceMember.findUnique({ where: { userId_companyId: { userId, companyId } } });
  if (!m) throw new ApiError("Member not found", 404);
  return m;
}

export async function changeRole(companyId: string, actor: { userId: string; email: string; role: string }, userId: string, role: WorkspaceRole) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { ownerId: true } });
  if (userId === company.ownerId) throw new ApiError("The owner's role can't be changed. Transfer ownership instead.", 409);
  if (userId === actor.userId) throw new ApiError("You can't change your own role", 403);
  const m = await memberOf(companyId, userId);
  assertCanGrant(actor.role, role);
  if (ROLE_RANK[m.role] >= ROLE_RANK[actor.role]) throw new ApiError("You can only change the role of members below you", 403);
  await prisma.workspaceMember.update({ where: { id: m.id }, data: { role } });
  await audit(companyId, actor.email, "MEMBER_ROLE_CHANGED", userId, `${m.role} → ${role}`);
  return { userId, role };
}

export async function removeMember(companyId: string, actor: { userId: string; email: string; role: string }, userId: string) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { ownerId: true } });
  if (userId === company.ownerId) throw new ApiError("The owner can't be removed. Transfer ownership first.", 409);
  const m = await memberOf(companyId, userId);
  const self = userId === actor.userId;
  if (!self && ROLE_RANK[m.role] >= ROLE_RANK[actor.role]) throw new ApiError("You can only remove members below you", 403);
  await prisma.workspaceMember.delete({ where: { id: m.id } });
  await audit(companyId, actor.email, self ? "MEMBER_LEFT" : "MEMBER_REMOVED", userId, `was ${m.role.toLowerCase()}`);
  return { removed: true };
}

export async function transferOwnership(companyId: string, actor: { userId: string; email: string }, toUserId: string) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { ownerId: true } });
  if (company.ownerId !== actor.userId) throw new ApiError("Only the current owner can transfer ownership", 403);
  if (toUserId === actor.userId) throw new ApiError("You already own this workspace", 409);
  const target = await memberOf(companyId, toUserId);
  await prisma.$transaction([
    prisma.company.update({ where: { id: companyId }, data: { ownerId: toUserId } }),
    prisma.workspaceMember.update({ where: { id: target.id }, data: { role: "OWNER" } }),
    prisma.workspaceMember.upsert({ where: { userId_companyId: { userId: actor.userId, companyId } }, create: { userId: actor.userId, companyId, role: "ADMIN" }, update: { role: "ADMIN" } }),
  ]);
  await audit(companyId, actor.email, "OWNERSHIP_TRANSFERRED", toUserId, "previous owner is now an admin");
  return { ownerId: toUserId };
}
