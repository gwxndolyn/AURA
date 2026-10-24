import { NextResponse } from "next/server";
import { handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { loadProduct } from "@/lib/factory/store";
import { archive, assertBranch } from "@/lib/factory/git";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/** Download the source code at a branch (default: main) as a .tar.gz produced by `git archive`. */
export const GET = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const p = await loadProduct(id, productId);
  if (!p.repoId) throw new ApiError("Product has no repository", 404);
  const repo = await prisma.repoConnection.findFirst({ where: { id: p.repoId, companyId: id } });
  if (!repo) throw new ApiError("Repository not found", 404);
  const ref = assertBranch(new URL(req.url).searchParams.get("branch") ?? repo.defaultBranch);
  const buf = await archive(id, repo.id, ref);
  const name = `${p.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40) || "project"}-${ref.replace(/\//g, "-")}.tar.gz`;
  return new NextResponse(new Uint8Array(buf), { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${name}"` } });
});
