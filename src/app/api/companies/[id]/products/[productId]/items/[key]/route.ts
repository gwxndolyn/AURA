import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { userSetItemStatus, setPriority } from "@/lib/factory/store";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string; key: string }> };

const Patch = z.union([
  z.object({ status: z.enum(["READY", "TODO", "CANCELLED", "BLOCKED", "DONE_UNVERIFIED", "VERIFIED"]), note: z.string().max(400).optional() }),
  z.object({ priority: z.number().int().min(0).max(10000) }),
]);

/**
 * Person-initiated item changes. Status edges are enforced by the lifecycle
 * model: VERIFIED is refused here (only execution evidence sets it), and
 * DONE_UNVERIFIED is refused for tasks with an executable test suite.
 */
export const PATCH = handler(async (req, ctx: Ctx) => {
  const { id, productId, key } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const b = await parseBody(req, Patch);
  if ("priority" in b) return ok(await setPriority(id, productId, decodeURIComponent(key), user.email, b.priority));
  return ok(await userSetItemStatus(id, productId, decodeURIComponent(key), user.email, b.status, b.note));
});
