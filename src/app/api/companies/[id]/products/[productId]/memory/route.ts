import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess, AuthError } from "@/lib/auth/authz";
import { loadProduct } from "@/lib/factory/store";
import { listMemory, setMemoryStatus } from "@/lib/factory/memory";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  await loadProduct(id, productId);
  return ok(await listMemory(id, productId));
});

/**
 * Invalidate a memory (MEMBER+) or confirm it as a verified, approved fact
 * (ADMIN+ — a confirmed memory is injected into agents as truth).
 */
export const PATCH = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const b = await parseBody(req, z.object({ memoryId: z.string().min(1).max(64), status: z.enum(["VERIFIED", "INVALIDATED"]), note: z.string().max(300).optional() }));
  const { user, role } = await requireWorkspaceAccess(id, "MEMBER");
  if (b.status === "VERIFIED" && !["OWNER", "ADMIN"].includes(role)) throw new AuthError(403, "Confirming a memory as a verified fact needs an admin");
  return ok(await setMemoryStatus(id, productId, b.memoryId, user.email, b.status, b.note));
});
