import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { registerUser, createEmailVerification } from "@/lib/auth/service";
import { setSessionCookie } from "@/lib/auth/session";
import { rateLimit, clientIp } from "@/lib/auth/rateLimit";
import { AuthError } from "@/lib/auth/authz";
import { sendVerificationEmail } from "@/lib/auth/mail";
import { securityEvent } from "@/lib/auth/events";

export const dynamic = "force-dynamic";

const Schema = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(80),
  password: z.string().min(1).max(200),
});

export const POST = handler(async (req) => {
  const ip = clientIp(req);
  const rl = rateLimit(`register:${ip}`, Number(process.env.AURA_REGISTER_LIMIT_PER_HOUR || 5), 60 * 60 * 1000);
  if (!rl.ok) throw new AuthError(429, "Too many sign-ups from this network. Try again later.");

  const body = await parseBody(req, Schema);
  const user = await registerUser(body);
  await setSessionCookie({ userId: user.id, email: user.email, sessionVersion: user.sessionVersion });
  const v = await createEmailVerification(user.id);
  const mail = v ? await sendVerificationEmail(req, v.email, v.rawToken) : { sent: false, configured: false };
  await securityEvent("ACCOUNT_CREATED", { userId: user.id, email: user.email, ip });
  return ok({ user, verification: mail }, { status: 201 });
});
