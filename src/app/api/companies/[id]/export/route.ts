import { NextResponse } from "next/server";
import { handler, ApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { exportWorkspace } from "@/lib/lifecycle/export";
import { audit } from "@/lib/events/emit";
import { rateLimit } from "@/lib/auth/rateLimit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

/** Download a JSON export of the workspace's records (data.export, ADMIN+). Audited. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requirePermission(id, "data.export");
  if (!rateLimit(`export:${id}`, 5, 60 * 60_000).ok) throw new ApiError("Exports are limited to 5 per hour", 429);
  const data = await exportWorkspace(id);
  await audit(id, user.email, "DATA_EXPORTED", id, `${data.products.length} product(s), ${data.runs.length} run(s), ${data.audit.length} audit entries`);
  return new NextResponse(JSON.stringify(data, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="aura-export-${id}-${new Date().toISOString().slice(0, 10)}.json"`, "cache-control": "no-store" } });
});
