import { ok, handler } from "@/lib/api";
import { requireUser } from "@/lib/auth/authz";
import { ensureDemoWorkspace } from "@/lib/demo/service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Open the signed-in user's demo workspace, creating it on first use. Each
 * user gets their own isolated copy — there is no shared demo account.
 */
export const POST = handler(async () => {
  const user = await requireUser();
  const r = await ensureDemoWorkspace(user.userId);
  return ok(r, { status: r.created ? 201 : 200 });
});
