import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { listFindings } from "@/lib/ops/read";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const list = (v: string | null) => (v ? v.split(",").filter(Boolean).slice(0, 10) : undefined);

export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const u = new URL(req.url);
  const hours = Number(u.searchParams.get("hours") ?? 0);
  return ok(
    await listFindings(id, {
      status: list(u.searchParams.get("status")),
      severity: list(u.searchParams.get("severity")),
      category: list(u.searchParams.get("category")),
      resourceType: u.searchParams.get("resource") ?? undefined,
      since: hours > 0 ? new Date(Date.now() - Math.min(hours, 24 * 90) * 3600_000) : undefined,
    }),
  );
});
