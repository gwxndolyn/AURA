import { ok, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { fileHistory } from "@/lib/devspace/files";
import { PathError } from "@/lib/devspace/paths";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  try {
    return ok(await fileHistory(id, new URL(req.url).searchParams.get("path") ?? ""));
  } catch (e) {
    if (e instanceof PathError) throw new ApiError(e.message, 422);
    throw e;
  }
});
