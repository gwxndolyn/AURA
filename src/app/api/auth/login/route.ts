import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { loginUser } from "@/lib/auth/service";
import { setSessionCookie } from "@/lib/auth/session";
import { rateLimit, clientIp } from "@/lib/auth/rateLimit";
import { AuthError } from "@/lib/auth/authz";
import { securityEvent } from "@/lib/auth/events";

export const dynamic = "force-dynamic";

const Schema = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export const POST = handler(async (req) => {
  const ip = clientIp(req);
  const body = await parseBody(req, Schema);
  const email = body.email.trim().toLowerCase();
  // Per account (credential stuffing against one user) and per IP (spraying across users).
  if (!rateLimit(`login:acct:${email}`, 8, 15 * 60_000).ok || !rateLimit(`login:ip:${ip}`, 40, 15 * 60_000).ok) {
    await securityEvent("LOGIN_RATE_LIMITED", { email, ip, outcome: "denied" });
    throw new AuthError(429, "Too many sign-in attempts. Try again in 15 minutes, or reset your password.");
  }
  let user;
  try {
    user = await loginUser({ email, password: body.password });
  } catch (e) {
    await securityEvent("LOGIN_FAILED", { email, ip, outcome: "denied" });
    throw e;
  }
  await setSessionCookie({ userId: user.id, email: user.email, sessionVersion: user.sessionVersion });
  await securityEvent("LOGIN", { userId: user.id, email, ip });
  return ok({ user: { id: user.id, email: user.email, name: user.name, emailVerified: user.emailVerified } });
});
