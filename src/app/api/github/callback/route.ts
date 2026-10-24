import { NextResponse } from "next/server";
import { requireWorkspaceAccess, requireUser } from "@/lib/auth/authz";
import { connectInstallation, verifyInstallState } from "@/lib/integrations/github/service";
import { log } from "@/lib/observability/log";

export const dynamic = "force-dynamic";

/**
 * GitHub App "Setup URL" callback: ?installation_id&setup_action&state.
 * The signed state must match the signed-in user and a workspace they ADMIN.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (companyId: string | null, q: string) => NextResponse.redirect(new URL(companyId ? `/app/${companyId}/settings?tab=integrations&${q}` : `/app?${q}`, url.origin));
  const st = verifyInstallState(url.searchParams.get("state") ?? "");
  if (!st) return back(null, "github=invalid_state");
  try {
    const user = await requireUser();
    if (user.userId !== st.userId) return back(st.companyId, "github=wrong_user");
    const { user: u } = await requireWorkspaceAccess(st.companyId, "ADMIN");
    const installationId = Number(url.searchParams.get("installation_id"));
    if (!Number.isInteger(installationId) || installationId <= 0) return back(st.companyId, "github=missing_installation");
    await connectInstallation(st.companyId, u.email, installationId);
    return back(st.companyId, "github=connected");
  } catch (e) {
    log("warn", "github.callback_failed", { error: (e as Error).message });
    return back(st.companyId, `github=error&reason=${encodeURIComponent((e as Error).message.slice(0, 120))}`);
  }
}
