/**
 * Product-level read model over the code index (src/lib/builder/intel.ts):
 * the indexed default branch, and for one task the files/tests that relate to
 * it (lexical, labelled) plus the recorded impact of its last run.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { parseJSON } from "@/lib/utils";
import { indexSnapshot, relatedToText, type CodeIndexData } from "@/lib/builder/intel";
import { headSha, listFiles, readAt } from "./git";
import { loadProduct } from "./store";
import { integrationBase } from "./base";

async function filesAt(companyId: string, repoId: string, ref: string) {
  const out: Record<string, string> = {};
  for (const f of (await listFiles(companyId, repoId, ref)).slice(0, 600)) {
    if (/\.(c|m)?(j|t)sx?$|\.(json|md|html?|css|ya?ml|prisma|sql)$/.test(f) && !/(^|\/)(node_modules|\.git)\//.test(f) && f !== "package-lock.json") out[f] = (await readAt(companyId, repoId, ref, f)) ?? "";
  }
  return out;
}

export async function productIntel(companyId: string, productId: string, itemKey: string | null) {
  const p = await loadProduct(companyId, productId);
  if (!p.repoId) throw new ApiError("Product has no repository", 409);
  const repo = await prisma.repoConnection.findFirst({ where: { id: p.repoId, companyId } });
  if (!repo) throw new ApiError("Repository connection not found", 404);
  const base = await integrationBase(companyId, productId, repo);
  const sha = await headSha(companyId, repo.id, base.branch);
  if (!sha) throw new ApiError("Base branch not found", 404);
  const index: CodeIndexData = await indexSnapshot(companyId, repo.id, sha, await filesAt(companyId, repo.id, base.branch));
  let item: null | { key: string; related: ReturnType<typeof relatedToText>; impact: unknown; buildId: string | null } = null;
  if (itemKey) {
    const i = await prisma.backlogItem.findFirst({ where: { productId, companyId, key: itemKey } });
    if (!i) throw new ApiError("Item not found", 404);
    const b = i.buildId ? await prisma.build.findFirst({ where: { id: i.buildId, companyId }, select: { id: true, impact: true } }) : null;
    item = { key: i.key, related: relatedToText(index, `${i.title} ${i.description} ${parseJSON<string[]>(i.acceptance, []).join(" ")} ${parseJSON<string[]>(i.files, []).join(" ")}`), impact: b ? parseJSON(b.impact, {}) : null, buildId: b?.id ?? null };
  }
  return {
    branch: base.branch, baseSource: base.source, sha, parser: index.parser, limitations: index.limitations, config: index.config,
    files: index.files.map((f) => ({ path: f.path, lang: f.lang, size: f.size, symbols: f.symbols.length, imports: f.imports.length, external: f.external })),
    routes: index.routes, tests: index.tests, schema: index.schema, contracts: index.contracts,
    item,
  };
}
