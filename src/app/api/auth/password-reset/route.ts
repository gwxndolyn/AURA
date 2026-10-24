import { z } from "zod";
import { ok, handler } from "@/lib/api";
import { createPasswordReset, resetPassword } from "@/lib/auth/service";
import { rateLimit } from "@/lib/auth/rateLimit";
import { AuthError } from "@/lib/auth/authz";
import { sendEmail, emailConfigured } from "@/lib/email/send";

export const dynamic = "force-dynamic";

const RequestSchema = z.object({ email: z.string().email() });
const ResetSchema = z.object({ token: z.string().min(16), password: z.string().min(8).max(200) });

/**
 * POST {email} → emails a one-hour reset link (response never reveals whether
 * the account exists). POST {token,password} → sets the new password.
 * In development/test only, without an email provider, the link is returned
 * so the flow can be exercised; in production it is never returned.
 */
export const POST = handler(async (req) => {
  const ip = req.headers.get("x-forwarded-for") ?? "local";
  const raw = await req.json().catch(() => ({}));

  if (raw && typeof raw.token === "string") {
    const p = ResetSchema.safeParse(raw);
    if (!p.success) throw new AuthError(422, "Password must be at least 8 characters");
    await resetPassword(p.data.token, p.data.password);
    return ok({ reset: true });
  }

  const rl = rateLimit(`pwreset:${ip}`, 5, 60 * 60 * 1000);
  if (!rl.ok) throw new AuthError(429, "Too many requests. Try again later.");
  const p = RequestSchema.safeParse(raw);
  if (!p.success) throw new AuthError(422, "Enter a valid email address");
  const result = await createPasswordReset(p.data.email);
  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
  let devLink: string | undefined;
  if (result) {
    const link = `${origin}/reset-password?token=${encodeURIComponent(result.rawToken)}`;
    const sent = await sendEmail(p.data.email, "Reset your AURA password", `Someone asked to reset the password for this AURA account.\n\nReset it here (valid for one hour):\n${link}\n\nIf this wasn't you, ignore this email.`);
    if (!sent.sent && process.env.NODE_ENV !== "production") devLink = link;
  }
  return ok({ requested: true, emailConfigured: emailConfigured().configured, ...(devLink ? { devLink } : {}) });
});
