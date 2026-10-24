import { ok, handler } from "@/lib/api";
import { clearSessionCookie } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export const POST = handler(async () => {
  await clearSessionCookie();
  return ok({ loggedOut: true });
});
