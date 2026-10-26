import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { ok, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess, requirePermission } from "@/lib/auth/authz";
import { experienceOverview, requestAudit, auditScreenshot } from "@/lib/experience/service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/** Experience audits + findings (persisted records only). ?audit=<id>&screenshot=<n> streams a tenant-checked screenshot. */
export const GET = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const q = new URL(req.url).searchParams;
  if (q.get("screenshot") !== null && q.get("audit")) {
    const s = await auditScreenshot(id, productId, q.get("audit")!, Number(q.get("screenshot")));
    const file = s.file ? resolve(s.file) : null;
    if (!file || !file.startsWith(resolve(s.root) + sep)) throw new ApiError("Screenshot not found", 404);
    const buf = await readFile(file).catch(() => null);
    if (!buf) throw new ApiError("Screenshot expired or removed by retention", 404);
    return new NextResponse(new Uint8Array(buf), { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
  }
  return ok(await experienceOverview(id, productId));
});

/** Start an experience audit (durable job; one at a time per product). */
export const POST = handler(async (_req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requirePermission(id, "execution.start");
  return ok(await requestAudit(id, productId, user.email, "manual"), { status: 202 });
});
