import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { registerUser } from "@/lib/auth/service";
import { setSessionCookie } from "@/lib/auth/session";
import { rateLimit } from "@/lib/auth/rateLimit";
import { AuthError } from "@/lib/auth/authz";

export const dynamic = "force-dynamic";

const Schema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(80),
  password: z.string().min(8).max(200),
});

export const POST = handler(async (req) => {
  const ip = req.headers.get("x-forwarded-for") ?? "local";
  const rl = rateLimit(`register:${ip}`, Number(process.env.AURA_REGISTER_LIMIT_PER_HOUR || 5), 60 * 60 * 1000);
  if (!rl.ok) throw new AuthError(429, "Too many attempts. Try again later.");

  const body = await parseBody(req, Schema);
  const user = await registerUser(body);
  await setSessionCookie({ userId: user.id, email: user.email });
  return ok({ user }, { status: 201 });
});
