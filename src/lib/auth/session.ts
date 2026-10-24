import { createHmac, timingSafeEqual, randomBytes } from "crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";

/**
 * Server-side session management. A signed, self-contained token (HMAC-SHA256
 * over a base64url JSON payload, like a minimal JWT) is stored in an httpOnly,
 * SameSite=Lax cookie. The signing secret never leaves the server.
 *
 * Revocation: every token carries a `jti` and the user's `sessionVersion`.
 * `getSession()` rejects tokens whose jti was signed out (RevokedSession) or
 * whose version is older than the user's current one (bumped by password
 * change/reset and "sign out everywhere"). Middleware (edge) only checks the
 * signature and expiry; the authoritative check happens here, on every
 * protected request, via requireUser()/requireWorkspaceAccess().
 */

const COOKIE = "aura_session";
const MAX_AGE_S = 60 * 60 * 24 * 7; // 7 days

export const DEV_INSECURE_SECRET = "aura-dev-insecure-secret-change-me";

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET (>=16 chars) is required in production");
    }
    return DEV_INSECURE_SECRET;
  }
  return s;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

export interface SessionPayload {
  userId: string;
  email: string;
}

export interface VerifiedToken extends SessionPayload {
  jti: string;
  sv: number;
  exp: number;
}

interface TokenBody extends SessionPayload {
  iat: number;
  exp: number;
  jti: string;
  sv?: number;
}

export async function createSessionToken(payload: SessionPayload & { sessionVersion?: number }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let sv = payload.sessionVersion;
  if (sv === undefined) sv = (await prisma.user.findUnique({ where: { id: payload.userId }, select: { sessionVersion: true } }).catch(() => null))?.sessionVersion ?? 0;
  const body: TokenBody = { userId: payload.userId, email: payload.email, iat: now, exp: now + MAX_AGE_S, jti: randomBytes(12).toString("hex"), sv };
  const data = b64url(JSON.stringify(body));
  return `${data}.${sign(data)}`;
}

/** Signature + expiry only (no database). */
export function decodeSessionToken(token: string): VerifiedToken | null {
  try {
    const [data, sig] = token.split(".");
    if (!data || !sig) return null;
    const expected = sign(data);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const body = JSON.parse(Buffer.from(data, "base64url").toString()) as TokenBody;
    if (!body.userId || typeof body.exp !== "number" || !body.jti) return null;
    if (Math.floor(Date.now() / 1000) > body.exp) return null;
    return { userId: body.userId, email: body.email, jti: body.jti, sv: body.sv ?? 0, exp: body.exp };
  } catch {
    return null;
  }
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  const t = decodeSessionToken(token);
  return t ? { userId: t.userId, email: t.email } : null;
}

/** Full validation: signature, expiry, not signed out, session version current, user exists. */
export async function validateSessionToken(token: string): Promise<VerifiedToken | null> {
  const t = decodeSessionToken(token);
  if (!t) return null;
  const [user, revoked] = await Promise.all([
    prisma.user.findUnique({ where: { id: t.userId }, select: { sessionVersion: true, email: true } }),
    prisma.revokedSession.findUnique({ where: { jti: t.jti }, select: { jti: true } }),
  ]);
  if (!user || revoked || user.sessionVersion !== t.sv) return null;
  return { ...t, email: user.email };
}

export async function setSessionCookie(payload: SessionPayload & { sessionVersion?: number }) {
  const token = await createSessionToken(payload);
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

/** Sign out this browser: revoke the current token server-side, then clear the cookie. */
export async function clearSessionCookie() {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  const t = token ? decodeSessionToken(token) : null;
  if (t) await prisma.revokedSession.upsert({ where: { jti: t.jti }, create: { jti: t.jti, userId: t.userId, expiresAt: new Date(t.exp * 1000) }, update: {} }).catch(() => null);
  store.set(COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
}

/** Invalidate every session of a user (password change/reset, "sign out everywhere", account compromise). */
export async function revokeAllSessions(userId: string) {
  const u = await prisma.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } }, select: { sessionVersion: true } });
  return u.sessionVersion;
}

/** Drop revocation rows for tokens that have expired anyway. */
export async function purgeExpiredRevocations(now = new Date()) {
  return (await prisma.revokedSession.deleteMany({ where: { expiresAt: { lt: now } } })).count;
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  const t = await validateSessionToken(token);
  return t ? { userId: t.userId, email: t.email } : null;
}

export const SESSION_COOKIE = COOKIE;
