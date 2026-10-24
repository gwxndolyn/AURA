import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireUser, AuthError } from "@/lib/auth/authz";
import { changePassword } from "@/lib/auth/service";
import { setSessionCookie } from "@/lib/auth/session";
import { rateLimit } from "@/lib/auth/rateLimit";
import { securityEvent } from "@/lib/auth/events";

export const dynamic = "force-dynamic";

const Schema = z.object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200) });

/** Change password (current password required). Every other session is signed out; this browser gets a fresh session. */
export const POST = handler(async (req) => {
  const user = await requireUser();
  if (!rateLimit(`pwchange:${user.userId}`, 5, 15 * 60_000).ok) throw new AuthError(429, "Too many attempts. Try again later.");
  const { current, next } = await parseBody(req, Schema);
  const { sessionVersion } = await changePassword(user.userId, current, next);
  await setSessionCookie({ userId: user.userId, email: user.email, sessionVersion });
  await securityEvent("PASSWORD_CHANGED", { userId: user.userId, email: user.email });
  return ok({ changed: true, otherSessionsSignedOut: true });
});
