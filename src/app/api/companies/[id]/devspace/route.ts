import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess, ROLE_RANK } from "@/lib/auth/authz";
import { getWorkspace, listTree } from "@/lib/devspace/files";
import { CHECKS } from "@/lib/devspace/checks";
import { reapStaleRuns } from "@/lib/devspace/checks";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Project tree (paths, sizes, per-file revisions) + capabilities for this user. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { role } = await requireWorkspaceAccess(id, "VIEWER");
  await reapStaleRuns(id);
  const ws = await getWorkspace(id);
  return ok({
    name: ws.name,
    revision: ws.revision,
    template: ws.template,
    files: listTree(ws),
    canEdit: ROLE_RANK[role] >= ROLE_RANK.MEMBER,
    canDecide: ROLE_RANK[role] >= ROLE_RANK.ADMIN,
    checks: Object.values(CHECKS).map((c) => ({ id: c.id, label: c.label, supported: !!c.command, reason: c.unsupportedReason ?? null })),
    preview: { available: false, reason: "AURA has no isolated preview runtime: running project servers would need a separate origin and network-isolated container with port exposure, which the sandbox (network none, no ports) does not provide." },
  });
});
