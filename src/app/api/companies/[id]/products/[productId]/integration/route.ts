import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { loadProduct } from "@/lib/factory/store";
import { operationalReadiness } from "@/lib/factory/operations";
import { listFiles, readAt } from "@/lib/factory/git";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/**
 * Integration & reliability view: latest dependency graph (+ contract
 * findings), investigations of failed attempts grouped by root cause, recent
 * test selections, and the remediation status — all from stored records.
 */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const product = await loadProduct(id, productId);
  const [snap, investigations, builds] = await Promise.all([
    prisma.systemGraphSnapshot.findFirst({ where: { companyId: id, productId, NOT: { sha: { startsWith: "wip:" } } }, orderBy: { createdAt: "desc" } }),
    prisma.investigation.findMany({ where: { companyId: id, productId }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.build.findMany({ where: { companyId: id, productId, itemKey: { not: "RELEASE" } }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, itemKey: true, status: true, testSelection: true, changed: true, browser: true, createdAt: true } }),
  ]);
  const inv = investigations.map((i) => ({ id: i.id, buildId: i.buildId, itemKey: i.itemKey, attempt: i.attempt + 1, rootCause: i.rootCause, category: i.category, origin: i.origin, ambiguous: i.ambiguous, infrastructure: i.infrastructure, status: i.status, symptoms: parseJSON<{ id: string; kind: string; detail: string }[]>(i.symptoms, []), hypotheses: parseJSON<{ id: string; category: string; statement: string; score: number; explains: string[]; unexplained: string[]; fix: { kind: string; change: string; files: string[] } }[]>(i.hypotheses, []), requirements: parseJSON<string[]>(i.requirements, []), createdAt: i.createdAt }));
  // Group symptoms under their supported root cause (origin), so related errors appear together.
  const groups = Object.values(inv.reduce<Record<string, { origin: string; category: string; rootCause: string; infrastructure: boolean; status: string; investigations: string[]; symptoms: number }>>((acc, i) => { const k = i.origin || `unknown:${i.id}`; acc[k] ??= { origin: i.origin || "unknown", category: i.category, rootCause: i.rootCause || "cause not established", infrastructure: i.infrastructure, status: i.status, investigations: [], symptoms: 0 }; acc[k].investigations.push(i.id); acc[k].symptoms += i.symptoms.length; if (["OPEN", "REPAIRING"].includes(i.status)) acc[k].status = i.status; return acc; }, {}));
  // Operational readiness from the default branch's files + recorded deployment evidence.
  const repo = product.repoId ? await prisma.repoConnection.findFirst({ where: { id: product.repoId, companyId: id } }) : null;
  const files: Record<string, string> = {};
  if (repo) for (const f of (await listFiles(id, repo.id, repo.defaultBranch).catch(() => [] as string[])).filter((x) => /\.(c|m)?(j|t)sx?$/.test(x) && !x.includes("node_modules")).slice(0, 300)) { const c = await readAt(id, repo.id, repo.defaultBranch, f); if (c !== null) files[f] = c; }
  const operations = await operationalReadiness(id, productId, files);
  return ok({
    operations,
    graph: snap ? { sha: snap.sha, createdAt: snap.createdAt, ...parseJSON(snap.data, {}) } : null,
    findings: snap ? parseJSON(snap.findings, []) : [],
    causes: groups,
    investigations: inv,
    selections: builds.map((b) => ({ buildId: b.id, itemKey: b.itemKey, status: b.status, changed: parseJSON<string[]>(b.changed, []), selection: parseJSON(b.testSelection, {}), browser: parseJSON<{ status?: string; journeys?: unknown[] }>(b.browser, {}).status ?? null, createdAt: b.createdAt })),
  });
});
