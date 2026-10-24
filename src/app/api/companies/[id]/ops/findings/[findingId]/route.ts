import { z } from "zod";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/events/emit";
import { findingDetail } from "@/lib/ops/read";
import { appendFindingHistory } from "@/lib/ops/actions";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; findingId: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, findingId } = await ctx.params;
  const { role } = await requireWorkspaceAccess(id, "VIEWER");
  const f = await findingDetail(id, findingId, role);
  if (!f) throw new ApiError("Finding not found", 404);
  return ok(f);
});

// Lifecycle changes by a person. RESOLVED by a person is allowed but recorded as such;
// the next evaluation re-opens it if the condition still holds.
const Schema = z.object({
  status: z.enum(["ACKNOWLEDGED", "INVESTIGATING", "RESOLVED", "DISMISSED", "OPEN"]),
  note: z.string().max(500).optional(),
});
const ALLOWED: Record<string, string[]> = {
  OPEN: ["ACKNOWLEDGED", "INVESTIGATING", "RESOLVED", "DISMISSED"],
  ACKNOWLEDGED: ["INVESTIGATING", "RESOLVED", "DISMISSED", "OPEN"],
  INVESTIGATING: ["ACKNOWLEDGED", "RESOLVED", "DISMISSED", "OPEN"],
  RESOLVED: ["OPEN"],
  DISMISSED: ["OPEN"],
};

export const PATCH = handler(async (req, ctx: Ctx) => {
  const { id, findingId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, Schema);
  const f = await prisma.opsFinding.findFirst({ where: { id: findingId, companyId: id } });
  if (!f) throw new ApiError("Finding not found", 404);
  if (!ALLOWED[f.status]?.includes(body.status)) throw new ApiError(`Cannot move a ${f.status.toLowerCase()} finding to ${body.status.toLowerCase()}`, 409);
  const now = new Date();
  await prisma.opsFinding.update({
    where: { id: f.id },
    data: {
      status: body.status,
      ...(body.status === "ACKNOWLEDGED" ? { acknowledgedBy: user.email, acknowledgedAt: now } : {}),
      ...(body.status === "RESOLVED" ? { resolvedAt: now, resolvedBy: user.email, resolution: body.note ?? "Resolved by a person" } : {}),
      ...(body.status === "DISMISSED" ? { dismissedReason: body.note ?? "" } : {}),
      ...(body.status === "OPEN" ? { resolvedAt: null, resolvedBy: null, resolution: "", dismissedReason: "" } : {}),
    },
  });
  await appendFindingHistory(f.id, user.email, `status ${f.status.toLowerCase()} → ${body.status.toLowerCase()}`, body.note);
  await audit(id, user.email, "OPS_FINDING_STATUS", f.id, `${f.status} → ${body.status}`);
  return ok({ status: body.status });
});
