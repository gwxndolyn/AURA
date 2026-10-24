import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { loginUser } from "@/lib/auth/service";
import { setSessionCookie } from "@/lib/auth/session";
import { rateLimit } from "@/lib/auth/rateLimit";
import { AuthError } from "@/lib/auth/authz";

export const dynamic = "force-dynamic";

const Schema = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });

export const POST = handler(async (req) => {
  const ip = req.headers.get("x-forwarded-for") ?? "local";
  const body = await parseBody(req, Schema);
  // Rate limit per-ip and per-email to blunt credential stuffing.
  const rl = rateLimit(`login:${ip}:${body.email}`, 8, 15 * 60 * 1000);
  if (!rl.ok) throw new AuthError(429, "Too many login attempts. Try again later.");

  const user = await loginUser(body);
  await setSessionCookie({ userId: user.id, email: user.email });
  return ok({ user });
});
