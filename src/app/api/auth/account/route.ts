import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth/authz";
import { clearSessionCookie } from "@/lib/auth/session";
import { deleteAccount } from "@/lib/auth/account";

export const dynamic = "force-dynamic";

/** Permanently delete the signed-in account and the workspaces it owns (password re-confirmation required). */
export const DELETE = handler(async (req) => {
  const user = await requireUser();
  const { password } = await parseBody(req, z.object({ password: z.string().min(1) }));
  const r = await deleteAccount(user.userId, password);
  await clearSessionCookie();
  return ok(r);
});
