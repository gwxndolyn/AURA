/**
 * Transactional email. Provider: Resend HTTP API (RESEND_API_KEY + EMAIL_FROM).
 * Every message is written to the EmailMessage outbox first; delivery status
 * is recorded. Without a configured provider the message stays PENDING and
 * callers report "email is not configured" — nothing pretends it was sent.
 * RESEND_API_BASE may point at a test double in automated tests only.
 */
import { prisma } from "@/lib/db";
import { log } from "@/lib/observability/log";

export function emailConfigured() {
  const missing = ["RESEND_API_KEY", "EMAIL_FROM"].filter((k) => !process.env[k]);
  return { configured: missing.length === 0, missing };
}

/** One-time links (reset / verify / invite) must not sit in the outbox in usable form. */
export function outboxCopy(body: string) {
  return body.replace(/([?&](token|invite)=)[A-Za-z0-9%._-]+/g, "$1[redacted]");
}

export async function sendEmail(to: string, subject: string, body: string) {
  const msg = await prisma.emailMessage.create({ data: { to, subject, body: outboxCopy(body) } });
  if (!emailConfigured().configured) return { id: msg.id, status: "PENDING" as const, sent: false };
  try {
    const r = await fetch(`${process.env.RESEND_API_BASE || "https://api.resend.com"}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text: body }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`provider returned ${r.status}`);
    await prisma.emailMessage.update({ where: { id: msg.id }, data: { status: "SENT", sentAt: new Date() } });
    return { id: msg.id, status: "SENT" as const, sent: true };
  } catch (e) {
    await prisma.emailMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: (e as Error).message.slice(0, 300) } });
    log("error", "email.failed", { messageId: msg.id, error: (e as Error).message });
    return { id: msg.id, status: "FAILED" as const, sent: false };
  }
}
