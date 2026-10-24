/**
 * Account deletion. Deletes the workspaces the user owns (see
 * src/lib/lifecycle/deletion.ts for exactly what that removes and what is
 * retained elsewhere), memberships in other workspaces, tokens and the user row.
 * Paid subscriptions must be cancelled first so no charge continues after
 * deletion. Workspaces the user owns that have other members must be
 * transferred first, so teammates do not lose their work.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { verifyPassword } from "./password";
import { assertNoActivePaidPlan, deleteWorkspaceData, RETAINED_ELSEWHERE } from "@/lib/lifecycle/deletion";
import { audit } from "@/lib/events/emit";
import { log } from "@/lib/observability/log";

export async function deleteAccount(userId: string, password: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError("Account not found", 404);
  if (!(await verifyPassword(password, user.passwordHash))) throw new ApiError("Password is incorrect", 403);
  const owned = await prisma.company.findMany({ where: { ownerId: userId }, select: { id: true, name: true, isDemo: true, _count: { select: { members: true } } } });
  const shared = owned.filter((c) => !c.isDemo && c._count.members > 1);
  if (shared.length) throw new ApiError(`Transfer ownership of ${shared.map((c) => `"${c.name}"`).join(", ")} to a teammate first (Settings → Members), or remove the other members.`, 409);
  await assertNoActivePaidPlan(owned.map((c) => c.id));
  const problems: string[] = [];
  for (const c of owned) problems.push(...(await deleteWorkspaceData(c.id)).problems);
  const memberships = await prisma.workspaceMember.findMany({ where: { userId }, select: { companyId: true } });
  for (const m of memberships) await audit(m.companyId, user.email, "MEMBER_LEFT", userId, "account deleted").catch(() => null);
  await prisma.$transaction([
    prisma.workspaceMember.deleteMany({ where: { userId } }),
    prisma.passwordResetToken.deleteMany({ where: { userId } }),
    prisma.revokedSession.deleteMany({ where: { userId } }),
    prisma.invitation.deleteMany({ where: { invitedBy: userId, acceptedAt: null } }),
    prisma.user.delete({ where: { id: userId } }),
  ]);
  log("info", "account.deleted", { userId, workspaces: owned.length, problems });
  return { deleted: true, workspaces: owned.length, problems, retainedElsewhere: RETAINED_ELSEWHERE };
}
