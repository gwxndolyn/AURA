import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth/authz";
import { acceptInvitation, previewInvitation } from "@/lib/auth/members";
import { rateLimit, clientIp } from "@/lib/auth/rateLimit";
import { AuthError } from "@/lib/auth/authz";

export const dynamic = "force-dynamic";

/** GET ?token= → workspace name + role (no sign-in needed to see what you were invited to). */
export const GET = handler(async (req) => {
  if (!rateLimit(`invite-preview:${clientIp(req)}`, 60, 60 * 60_000).ok) throw new AuthError(429, "Too many requests");
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (token.length < 16 || token.length > 200) throw new AuthError(404, "This invitation is invalid or has expired.");
  return ok(await previewInvitation(token));
});

/** POST {token} → accept as the signed-in user (email must match the invitation). */
export const POST = handler(async (req) => {
  const user = await requireUser();
  const { token } = await parseBody(req, z.object({ token: z.string().min(16).max(200) }));
  return ok(await acceptInvitation(token, user));
});
