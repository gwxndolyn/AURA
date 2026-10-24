/** Auth emails (verification). Delivery status is reported honestly: unconfigured email is never shown as "sent". */
import { sendEmail, emailConfigured } from "@/lib/email/send";

export function appOrigin(req: Request) {
  return process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
}

export async function sendVerificationEmail(req: Request, email: string, rawToken: string) {
  const link = `${appOrigin(req)}/verify-email?token=${encodeURIComponent(rawToken)}`;
  const r = await sendEmail(email, "Confirm your AURA email address", `Confirm this address for your AURA account (link valid for 48 hours):\n${link}\n\nIf you didn't create an account, ignore this email.`);
  const configured = emailConfigured().configured;
  return { sent: r.sent, configured, ...(!r.sent && process.env.NODE_ENV !== "production" ? { devLink: link } : {}) };
}
