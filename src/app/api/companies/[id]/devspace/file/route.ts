import { z } from "zod";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { getWorkspace, readFile, ConflictError } from "@/lib/devspace/files";
import { PathError } from "@/lib/devspace/paths";
import { saveUserEdit } from "@/lib/devspace/changes";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

function wrap(e: unknown): never {
  if (e instanceof PathError) throw new ApiError(e.message, 422);
  if (e instanceof ConflictError) throw new ApiError(e.message, 409);
  throw e;
}

/** Read one project file (path validated; never a server filesystem path). */
export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const path = new URL(req.url).searchParams.get("path") ?? "";
  try {
    const f = readFile(await getWorkspace(id), path);
    if (!f) throw new ApiError("File not found (it may have been deleted)", 404);
    return ok(f);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    wrap(e);
  }
});

const Save = z.object({ path: z.string().min(1).max(200), content: z.string().max(210_000), expectedRev: z.number().int().min(0) });

/** Save a direct edit. 409 if the file moved since it was opened (no silent overwrite). */
export const PUT = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, Save);
  try {
    return ok(await saveUserEdit(id, user.email, body.path, body.content, body.expectedRev));
  } catch (e) {
    wrap(e);
  }
});
