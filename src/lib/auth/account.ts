/**
 * Account deletion. Deletes the workspaces the user owns (cascading to their
 * products, backlog, builds, command output, usage, integrations and audit
 * log), their git repositories and working trees on disk, memberships in
 * other workspaces, and the user row. Paid subscriptions must be cancelled
 * first so no charge continues after deletion.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { verifyPassword } from "./password";
import { gitRoot } from "@/lib/factory/git";
import { workRoot } from "@/lib/builder/workspace";
import { log } from "@/lib/observability/log";

export async function deleteAccount(userId: string, password: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError("Account not found", 404);
  if (!(await verifyPassword(password, user.passwordHash))) throw new ApiError("Password is incorrect", 403);
  const owned = await prisma.company.findMany({ where: { ownerId: userId }, select: { id: true } });
  const paid = await prisma.subscription.findFirst({ where: { companyId: { in: owned.map((c) => c.id) }, status: { in: ["active", "trialing", "past_due"] }, plan: { not: "free" } } });
  if (paid) throw new ApiError("Cancel your paid subscription (Settings → Billing → Manage billing) before deleting your account", 409);
  for (const c of owned) {
    await rm(join(gitRoot(), c.id), { recursive: true, force: true });
    await rm(join(workRoot(), c.id), { recursive: true, force: true });
  }
  await prisma.$transaction([
    prisma.company.deleteMany({ where: { ownerId: userId } }),
    prisma.workspaceMember.deleteMany({ where: { userId } }),
    prisma.passwordResetToken.deleteMany({ where: { userId } }),
    prisma.user.delete({ where: { id: userId } }),
  ]);
  log("info", "account.deleted", { userId, workspaces: owned.length });
  return { deleted: true, workspaces: owned.length };
}
