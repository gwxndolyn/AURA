import { prisma } from "@/lib/db";
import { clamp } from "@/lib/utils";

/**
 * Security score computed from ACTUAL simulated state (open findings, incidents,
 * infra health, tech debt) — not asked of the model. Broken into categories,
 * each backed by evidence.
 */

const SEVERITY_WEIGHT: Record<string, number> = {
  LOW: 3,
  MEDIUM: 7,
  HIGH: 14,
  CRITICAL: 24,
};

export interface ScoreCategory {
  key: string;
  label: string;
  score: number; // 0-100
  evidence: string;
}

export async function computeSecurityScore(companyId: string): Promise<{
  total: number;
  categories: ScoreCategory[];
}> {
  const [findings, activeIncidents, nodes] = await Promise.all([
    prisma.securityFinding.findMany({ where: { companyId } }),
    prisma.incident.count({ where: { companyId, status: "ACTIVE" } }),
    prisma.infrastructureNode.findMany({ where: { companyId } }),
  ]);

  const open = findings.filter((f) => f.status === "OPEN" || f.status === "PATCHING");
  const byCat = (cat: string) => open.filter((f) => f.category === cat);
  const penalty = (list: typeof findings) =>
    list.reduce((s, f) => s + (SEVERITY_WEIGHT[f.severity] ?? 7), 0);

  const cat = (key: string, label: string, cats: string[]): ScoreCategory => {
    const list = open.filter((f) => cats.includes(f.category));
    const score = clamp(100 - penalty(list), 0, 100);
    return {
      key,
      label,
      score,
      evidence: list.length
        ? `${list.length} open finding(s): ${list.map((f) => f.title).slice(0, 2).join("; ")}`
        : "No open findings in this category.",
    };
  };

  const avgErr = nodes.length ? nodes.reduce((s, n) => s + n.errorRate, 0) / nodes.length : 0;
  const unhealthy = nodes.filter((n) => n.status !== "HEALTHY").length;

  const categories: ScoreCategory[] = [
    cat("authentication", "Authentication", ["authentication"]),
    cat("authorization", "Authorization", ["authorization"]),
    cat("appsec", "Application Security", ["application-security"]),
    cat("dependencies", "Dependencies", ["dependencies"]),
    cat("secrets", "Secrets", ["secrets"]),
    {
      key: "network",
      label: "Network",
      score: clamp(100 - unhealthy * 15 - avgErr * 10, 0, 100),
      evidence: unhealthy
        ? `${unhealthy} node(s) not healthy.`
        : "All infrastructure nodes healthy.",
    },
    {
      key: "monitoring",
      label: "Monitoring",
      score: clamp(100 - avgErr * 20, 0, 100),
      evidence: `Avg error rate ${avgErr.toFixed(2)}% across services.`,
    },
    {
      key: "incident-response",
      label: "Incident Response",
      score: clamp(100 - activeIncidents * 25, 0, 100),
      evidence: activeIncidents
        ? `${activeIncidents} active incident(s).`
        : "No active incidents.",
    },
  ];

  const total = Math.round(
    categories.reduce((s, c) => s + c.score, 0) / categories.length,
  );

  return { total, categories };
}

/** Recompute and persist the company's securityScore. */
export async function refreshSecurityScore(companyId: string): Promise<number> {
  const { total } = await computeSecurityScore(companyId);
  await prisma.company.update({ where: { id: companyId }, data: { securityScore: total } });
  return total;
}
