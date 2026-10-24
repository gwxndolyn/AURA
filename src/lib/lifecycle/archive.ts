/**
 * Product archival: an archived product is read-only (no ticks, no runs, no
 * deploys, no change requests), does not count against the active-products
 * limit, and keeps its repository, history and artifacts. Restoring returns it
 * to the status it had (counted against the limit again).
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { audit } from "@/lib/events/emit";
import { assertCanStart } from "@/lib/billing/entitlements";
import { loadProduct } from "@/lib/factory/store";

export async function archiveProduct(companyId: string, productId: string, actor: string) {
  const p = await loadProduct(companyId, productId);
  if (p.status === "ARCHIVED") throw new ApiError("Product is already archived", 409);
  const running = await prisma.build.count({ where: { companyId, productId, status: { in: ["QUEUED", "RUNNING"] } } });
  if (running) throw new ApiError(`${running} engineering run(s) are still in progress — pause the product and wait, or cancel it first`, 409);
  await prisma.product.update({ where: { id: p.id }, data: { status: "ARCHIVED", archivedAt: new Date(), archivedFrom: p.status } });
  await prisma.productApproval.updateMany({ where: { productId: p.id, status: "PENDING" }, data: { status: "CANCELLED", decidedBy: actor, decidedAt: new Date(), note: "product archived" } });
  await audit(companyId, actor, "PRODUCT_ARCHIVED", p.id, p.title);
  return { status: "ARCHIVED" };
}

export async function restoreProduct(companyId: string, productId: string, actor: string) {
  const p = await loadProduct(companyId, productId);
  if (p.status !== "ARCHIVED") throw new ApiError("Product is not archived", 409);
  const to = p.archivedFrom && p.archivedFrom !== "ARCHIVED" ? p.archivedFrom : "PAUSED";
  if (to !== "CANCELLED") await assertCanStart(companyId, "product");
  await prisma.product.update({ where: { id: p.id }, data: { status: to === "ACTIVE" ? "PAUSED" : to, archivedAt: null, archivedFrom: null } });
  await audit(companyId, actor, "PRODUCT_RESTORED", p.id, `restored as ${to === "ACTIVE" ? "paused (resume to continue)" : to.toLowerCase()}`);
  return { status: to === "ACTIVE" ? "PAUSED" : to };
}
