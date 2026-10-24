/**
 * Account-level security events (login, logout, password changes, rate-limit
 * hits). They are structured logs always, and — because AuditLog is
 * tenant-scoped — also audit entries in every workspace the user belongs to,
 * so workspace admins can see sign-in activity of their members.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/events/emit";
import { log } from "@/lib/observability/log";

export async function securityEvent(action: string, f: { userId?: string; email?: string; ip?: string; outcome?: "success" | "denied" | "failure"; detail?: string }) {
  log(f.outcome === "denied" ? "warn" : "info", `auth.${action.toLowerCase()}`, { userId: f.userId, ip: f.ip, outcome: f.outcome ?? "success" });
  let userId = f.userId;
  if (!userId && f.email) userId = (await prisma.user.findUnique({ where: { email: f.email }, select: { id: true } }).catch(() => null))?.id;
  if (!userId) return; // unknown account: log only (never create tenant rows for strangers)
  const ws = await prisma.workspaceMember.findMany({ where: { userId }, select: { companyId: true }, take: 20 });
  const u = f.email ?? (await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email ?? userId;
  for (const w of ws) await audit(w.companyId, u, action, userId, f.detail ?? (f.ip ? `from ${f.ip}` : ""), { category: "security", outcome: f.outcome ?? "success" }).catch(() => null);
}
