import { ok, handler } from "@/lib/api";
import { requireUser } from "@/lib/auth/authz";
import { revokeAllSessions, setSessionCookie } from "@/lib/auth/session";
import { securityEvent } from "@/lib/auth/events";

export const dynamic = "force-dynamic";

/** Sign out every OTHER session (this browser is re-issued a fresh session). */
export const DELETE = handler(async () => {
  const user = await requireUser();
  const sessionVersion = await revokeAllSessions(user.userId);
  await setSessionCookie({ userId: user.userId, email: user.email, sessionVersion });
  await securityEvent("SESSIONS_REVOKED_OTHERS", { userId: user.userId, email: user.email });
  return ok({ revoked: true });
});
