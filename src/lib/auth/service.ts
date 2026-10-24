import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword, sha256, randomToken } from "./password";
import { AuthError } from "./authz";
import { revokeAllSessions } from "./session";

/**
 * Auth service: registration, login, password reset/change, email
 * verification. Pure data operations (no cookie handling — that stays in
 * session.ts / routes). Rate limiting is applied at the route layer.
 *
 * Enumeration resistance: login does the same scrypt work whether or not the
 * account exists and returns one generic error; password-reset never reveals
 * whether an email is registered. Registration of an existing email returns a
 * generic conflict (unavoidable for a signup form) but is rate-limited per IP.
 */

export const MIN_PASSWORD = 10;
const COMMON = new Set(["password123", "1234567890", "qwertyuiop", "password1!", "letmein123", "iloveyou12", "aura123456"]);

export function passwordProblem(pw: string, email?: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (pw.length > 200) return "Password is too long";
  if (COMMON.has(pw.toLowerCase())) return "That password is too common; choose another";
  if (email && pw.toLowerCase().includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length >= 4) return "Password must not contain your email name";
  return null;
}

// A real hash of a random string, so failed lookups cost the same as wrong passwords.
let dummyHash: Promise<string> | null = null;
const dummy = () => (dummyHash ??= hashPassword(randomToken(16)));

export async function registerUser(input: { email: string; name: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError(422, "Invalid email");
  const problem = passwordProblem(input.password, email);
  if (problem) throw new AuthError(422, problem);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new AuthError(409, "An account with this email already exists. Sign in, or reset your password.");

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: { email, name: input.name.trim() || email.split("@")[0], passwordHash },
    select: { id: true, email: true, name: true, sessionVersion: true },
  });
  return user;
}

export async function loginUser(input: { email: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = user?.passwordHash ? await verifyPassword(input.password, user.passwordHash) : (await verifyPassword(input.password, await dummy()), false);
  if (!user || !ok) throw new AuthError(401, "Invalid email or password");
  return { id: user.id, email: user.email, name: user.name, sessionVersion: user.sessionVersion, emailVerified: !!user.emailVerifiedAt };
}

/**
 * Create a one-time token. Returns the RAW token (to be emailed); only its
 * sha256 is stored. Older unused tokens of the same purpose are invalidated.
 */
async function issueToken(userId: string, purpose: "reset" | "verify_email", ttlMs: number) {
  const rawToken = randomToken();
  await prisma.passwordResetToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.passwordResetToken.create({ data: { userId, purpose, tokenHash: sha256(rawToken), expiresAt: new Date(Date.now() + ttlMs) } });
  return rawToken;
}

export async function createPasswordReset(email: string): Promise<{ userId: string; rawToken: string } | null> {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) return null; // do not reveal whether the email exists
  return { userId: user.id, rawToken: await issueToken(user.id, "reset", 60 * 60 * 1000) };
}

/** Consume a token atomically (a token can be used once even under concurrent requests). */
async function consume(rawToken: string, purpose: "reset" | "verify_email") {
  const token = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (!token || token.purpose !== purpose || token.usedAt || token.expiresAt < new Date()) return null;
  const r = await prisma.passwordResetToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: new Date() } });
  return r.count === 1 ? token : null;
}

/** Set a new password from a reset link. Every existing session of the account is revoked. */
export async function resetPassword(rawToken: string, newPassword: string) {
  const token = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
  const u = token ? await prisma.user.findUnique({ where: { id: token.userId }, select: { email: true } }) : null;
  const problem = passwordProblem(newPassword, u?.email);
  if (problem) throw new AuthError(422, problem);
  const used = await consume(rawToken, "reset");
  if (!used) throw new AuthError(400, "Invalid or expired reset link. Request a new one.");
  // Reaching the inbox proves ownership of the address.
  await prisma.user.update({ where: { id: used.userId }, data: { passwordHash: await hashPassword(newPassword), emailVerifiedAt: new Date() } });
  await prisma.passwordResetToken.updateMany({ where: { userId: used.userId, usedAt: null }, data: { usedAt: new Date() } });
  await revokeAllSessions(used.userId);
  return { userId: used.userId };
}

/** Change password while signed in (current password required). Other sessions are revoked. */
export async function changePassword(userId: string, current: string, next: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !(await verifyPassword(current, user.passwordHash))) throw new AuthError(403, "Current password is incorrect");
  const problem = passwordProblem(next, user.email);
  if (problem) throw new AuthError(422, problem);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(next) } });
  return { sessionVersion: await revokeAllSessions(userId) };
}

export async function createEmailVerification(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true, email: true } });
  if (!user) throw new AuthError(404, "Account not found");
  if (user.emailVerifiedAt) return null;
  return { email: user.email, rawToken: await issueToken(userId, "verify_email", 48 * 3600 * 1000) };
}

export async function verifyEmail(rawToken: string) {
  const used = await consume(rawToken, "verify_email");
  if (!used) throw new AuthError(400, "Invalid or expired verification link. Request a new one from Settings → Account.");
  await prisma.user.update({ where: { id: used.userId }, data: { emailVerifiedAt: new Date() } });
  return { userId: used.userId };
}
