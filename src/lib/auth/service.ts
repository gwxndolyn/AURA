import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword, sha256, randomToken } from "./password";
import { AuthError } from "./authz";

/**
 * Auth service: registration, login, and password reset. Pure data operations
 * (no cookie handling — that stays in session.ts / routes). Rate limiting is
 * applied at the route layer.
 */

export async function registerUser(input: { email: string; name: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError(422, "Invalid email");
  if (input.password.length < 8) throw new AuthError(422, "Password must be at least 8 characters");

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new AuthError(409, "An account with this email already exists");

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: { email, name: input.name.trim() || email.split("@")[0], passwordHash },
    select: { id: true, email: true, name: true },
  });
  return user;
}

export async function loginUser(input: { email: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  // Constant-ish behavior: verifyPassword returns false for null hash too.
  const okUser = user && (await verifyPassword(input.password, user.passwordHash));
  if (!okUser) throw new AuthError(401, "Invalid email or password");
  return { id: user!.id, email: user!.email, name: user!.name };
}

/**
 * Create a password reset token. Returns the RAW token (to be emailed). Only
 * its sha256 is stored. In dev without email configured, the route surfaces the
 * token directly so the flow is testable.
 */
export async function createPasswordReset(email: string): Promise<{ userId: string; rawToken: string } | null> {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) return null; // do not reveal whether the email exists
  const rawToken = randomToken();
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: sha256(rawToken), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  return { userId: user.id, rawToken };
}

export async function resetPassword(rawToken: string, newPassword: string) {
  if (newPassword.length < 8) throw new AuthError(422, "Password must be at least 8 characters");
  const token = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (!token || token.usedAt || token.expiresAt < new Date()) throw new AuthError(400, "Invalid or expired reset token");
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: token.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: token.id }, data: { usedAt: new Date() } }),
  ]);
  return { userId: token.userId };
}
