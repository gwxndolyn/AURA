import { createHmac, timingSafeEqual, randomBytes } from "crypto";
import { cookies } from "next/headers";

/**
 * Server-side session management. A signed, self-contained token (HMAC-SHA256
 * over a base64url JSON payload, like a minimal JWT) is stored in an httpOnly,
 * SameSite=Lax cookie. The signing secret never leaves the server. Sessions are
 * validated server-side on every protected request. Uses only Node's built-in
 * crypto — no external dependency.
 */

const COOKIE = "aura_session";
const MAX_AGE_S = 60 * 60 * 24 * 7; // 7 days

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET (>=16 chars) is required in production");
    }
    return "aura-dev-insecure-secret-change-me";
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

interface TokenBody extends SessionPayload {
  iat: number;
  exp: number;
  jti: string;
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body: TokenBody = {
    userId: payload.userId,
    email: payload.email,
    iat: now,
    exp: now + MAX_AGE_S,
    jti: randomBytes(8).toString("hex"),
  };
  const data = b64url(JSON.stringify(body));
  return `${data}.${sign(data)}`;
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const [data, sig] = token.split(".");
    if (!data || !sig) return null;
    const expected = sign(data);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const body = JSON.parse(Buffer.from(data, "base64url").toString()) as TokenBody;
    if (!body.userId || typeof body.exp !== "number") return null;
    if (Math.floor(Date.now() / 1000) > body.exp) return null;
    return { userId: body.userId, email: body.email };
  } catch {
    return null;
  }
}

export async function setSessionCookie(payload: SessionPayload) {
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

export async function clearSessionCookie() {
  const store = await cookies();
  store.set(COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export const SESSION_COOKIE = COOKIE;
