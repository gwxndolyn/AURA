import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireUser, AuthError } from "@/lib/auth/authz";
import { createEmailVerification, verifyEmail } from "@/lib/auth/service";
import { sendVerificationEmail } from "@/lib/auth/mail";
import { rateLimit, clientIp } from "@/lib/auth/rateLimit";
import { securityEvent } from "@/lib/auth/events";

export const dynamic = "force-dynamic";

const Schema = z.union([z.object({ token: z.string().min(16).max(200) }), z.object({ resend: z.literal(true) })]);

/** {token} verifies an address from the emailed link; {resend:true} (signed in) sends a new link. */
export const POST = handler(async (req) => {
  const body = await parseBody(req, Schema);
  if ("token" in body) {
    if (!rateLimit(`verify:${clientIp(req)}`, 30, 60 * 60_000).ok) throw new AuthError(429, "Too many attempts. Try again later.");
    const r = await verifyEmail(body.token);
    await securityEvent("EMAIL_VERIFIED", { userId: r.userId });
    return ok({ verified: true });
  }
  const user = await requireUser();
  if (!rateLimit(`verify-resend:${user.userId}`, 3, 60 * 60_000).ok) throw new AuthError(429, "A verification email was sent recently. Check your inbox or try again later.");
  const v = await createEmailVerification(user.userId);
  if (!v) return ok({ alreadyVerified: true });
  return ok(await sendVerificationEmail(req, v.email, v.rawToken));
});
