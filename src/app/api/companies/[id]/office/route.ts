import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { officeSnapshot } from "@/lib/office/live";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Living office: agents + their current real work, recent interactions and evidence (read-only). */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  return ok(await officeSnapshot(id));
});
