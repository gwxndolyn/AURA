import { z } from "zod";
import { ok, handler } from "@/lib/api";
import { createPasswordReset, resetPassword } from "@/lib/auth/service";
import { rateLimit, clientIp } from "@/lib/auth/rateLimit";
import { AuthError } from "@/lib/auth/authz";
import { sendEmail, emailConfigured } from "@/lib/email/send";
import { appOrigin } from "@/lib/auth/mail";
import { securityEvent } from "@/lib/auth/events";

export const dynamic = "force-dynamic";

const RequestSchema = z.object({ email: z.string().email().max(200) });
const ResetSchema = z.object({ token: z.string().min(16).max(200), password: z.string().min(1).max(200) });

/**
 * POST {email} → emails a one-hour reset link (the response is identical
 * whether or not the account exists). POST {token,password} → sets the new
 * password and signs the account out everywhere. In development/test only,
 * without an email provider, the link is returned so the flow can be
 * exercised; in production it is never returned.
 */
export const POST = handler(async (req) => {
  const ip = clientIp(req);
  const raw = await req.json().catch(() => ({}));

  if (raw && typeof raw.token === "string") {
    if (!rateLimit(`pwreset-use:${ip}`, 20, 60 * 60 * 1000).ok) throw new AuthError(429, "Too many attempts. Try again later.");
    const p = ResetSchema.safeParse(raw);
    if (!p.success) throw new AuthError(422, "Enter a new password");
    const r = await resetPassword(p.data.token, p.data.password);
    await securityEvent("PASSWORD_RESET", { userId: r.userId, ip });
    return ok({ reset: true, signedOutEverywhere: true });
  }

  const p = RequestSchema.safeParse(raw);
  if (!p.success) throw new AuthError(422, "Enter a valid email address");
  const email = p.data.email.trim().toLowerCase();
  if (!rateLimit(`pwreset:${ip}`, 5, 60 * 60 * 1000).ok || !rateLimit(`pwreset:acct:${email}`, 3, 60 * 60 * 1000).ok) throw new AuthError(429, "Too many requests. Try again later.");
  const result = await createPasswordReset(email);
  let devLink: string | undefined;
  if (result) {
    const link = `${appOrigin(req)}/reset-password?token=${encodeURIComponent(result.rawToken)}`;
    const sent = await sendEmail(email, "Reset your AURA password", `Someone asked to reset the password for this AURA account.\n\nReset it here (valid for one hour):\n${link}\n\nIf this wasn't you, ignore this email — your password has not changed.`);
    if (!sent.sent && process.env.NODE_ENV !== "production") devLink = link;
    await securityEvent("PASSWORD_RESET_REQUESTED", { userId: result.userId, ip });
  }
  return ok({ requested: true, emailConfigured: emailConfigured().configured, ...(devLink ? { devLink } : {}) });
});
