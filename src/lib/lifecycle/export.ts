/**
 * Customer data export (data.export, ADMIN+): one JSON document of the
 * workspace's own records. Secret VALUES are never exported (names only);
 * password hashes, session/invitation token hashes and provider credentials are
 * never included. Source code is exported per product as git archives via
 * /products/[productId]/download (linked from the export's `sourceDownloads`).
 * Large text columns (command output, logs) are truncated in the export.
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";

const cut = (s: string | null | undefined, n = 4000) => (s && s.length > n ? `${s.slice(0, n)}… [truncated, ${s.length} chars]` : s ?? "");

export async function exportWorkspace(companyId: string) {
  const [company, members, products, briefs, items, artifacts, builds, deployments, targets, usage, audit, subscription, invoices, secrets, memories] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { id: true, name: true, mission: true, createdAt: true, monthlyBudgetUsd: true, retentionDays: true } }),
    prisma.workspaceMember.findMany({ where: { companyId }, select: { role: true, createdAt: true, user: { select: { email: true, name: true } } } }),
    prisma.product.findMany({ where: { companyId }, select: { id: true, title: true, idea: true, phase: true, status: true, stack: true, autonomy: true, createdAt: true, archivedAt: true } }),
    prisma.productBrief.findMany({ where: { companyId }, select: { productId: true, version: true, content: true, createdAt: true } }),
    prisma.backlogItem.findMany({ where: { companyId }, select: { productId: true, key: true, level: true, title: true, description: true, status: true, acceptance: true, createdAt: true } }),
    prisma.productArtifact.findMany({ where: { companyId }, select: { productId: true, kind: true, version: true, title: true, status: true, content: true, createdAt: true } }),
    prisma.build.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 2000, select: { id: true, productId: true, itemKey: true, status: true, branch: true, headSha: true, summary: true, failure: true, costUsd: true, tokensIn: true, tokensOut: true, createdAt: true, finishedAt: true } }),
    prisma.productDeployment.findMany({ where: { companyId }, select: { id: true, productId: true, env: true, provider: true, sha: true, status: true, url: true, createdAt: true, finishedAt: true } }),
    prisma.deployTarget.findMany({ where: { companyId }, select: { productId: true, env: true, provider: true, config: true, secretEnvNames: true } }),
    prisma.usageEvent.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 20000, select: { metric: true, quantity: true, source: true, basis: true, model: true, period: true, createdAt: true } }),
    prisma.auditLog.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 20000, select: { actor: true, action: true, target: true, result: true, category: true, outcome: true, createdAt: true } }),
    prisma.subscription.findUnique({ where: { companyId }, select: { plan: true, status: true, interval: true, currentPeriodEnd: true, cancelAtPeriodEnd: true } }),
    prisma.invoice.findMany({ where: { companyId }, select: { id: true, number: true, status: true, currency: true, amountDue: true, amountPaid: true, periodStart: true, periodEnd: true } }),
    prisma.workspaceSecret.findMany({ where: { companyId }, select: { name: true, createdAt: true, updatedAt: true, lastUsedAt: true } }),
    prisma.projectMemory.findMany({ where: { companyId }, select: { productId: true, key: true, kind: true, content: true, status: true, createdAt: true } }),
  ]);
  return {
    format: "aura-workspace-export/1",
    exportedAt: new Date().toISOString(),
    notes: ["Secret values are never exported (names only).", "Source code: download each product's repository with the links in sourceDownloads.", "Long text fields are truncated."],
    workspace: company,
    members: members.map((m) => ({ email: m.user.email, name: m.user.name, role: m.role, joinedAt: m.createdAt })),
    subscription,
    invoices,
    products,
    sourceDownloads: products.map((p) => ({ productId: p.id, url: `/api/companies/${companyId}/products/${p.id}/download` })),
    briefs: briefs.map((b) => ({ ...b, content: parseJSON(b.content, b.content) })),
    backlog: items,
    artifacts: artifacts.map((a) => ({ ...a, content: cut(a.content, 20000) })),
    runs: builds.map((b) => ({ ...b, failure: cut(b.failure), summary: cut(b.summary) })),
    deployments,
    deployTargets: targets.map((t) => ({ ...t, config: parseJSON(t.config, {}), secretEnvNames: parseJSON(t.secretEnvNames, []) })),
    secrets,
    memory: memories,
    usage,
    audit,
  };
}
