import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { auditSkills } from "@/lib/intelligence/skillAudit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

/**
 * Read-only audit of the repository's Claude Code skills + prompt library.
 * Developer tooling: restricted to ADMIN, and the absolute repo root is not
 * exposed in the response.
 */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "ADMIN");
  const report = auditSkills(process.cwd());
  return ok({ ...report, root: "." });
});
