import { z } from "zod";
import { ok, handler } from "@/lib/api";
import { clearSessionCookie, getSession, revokeAllSessions } from "@/lib/auth/session";
import { securityEvent } from "@/lib/auth/events";

export const dynamic = "force-dynamic";

const Schema = z.object({ everywhere: z.boolean().optional() }).optional();

/** Sign out: this token is revoked server-side. {everywhere:true} invalidates every session of the account. */
export const POST = handler(async (req) => {
  const raw = await req.json().catch(() => undefined);
  const body = Schema.safeParse(raw).success ? Schema.parse(raw) : undefined;
  const session = await getSession();
  if (session && body?.everywhere) {
    await revokeAllSessions(session.userId);
    await securityEvent("SESSIONS_REVOKED_ALL", { userId: session.userId, email: session.email });
  }
  await clearSessionCookie();
  if (session) await securityEvent("LOGOUT", { userId: session.userId, email: session.email });
  return ok({ loggedOut: true, everywhere: !!body?.everywhere });
});
