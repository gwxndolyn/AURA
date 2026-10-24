import { prisma } from "@/lib/db";
import { AGENT_DEFS } from "@/lib/agents/definitions";
import { permissionsFor } from "@/lib/agents/permissions";
import { emitEvent } from "@/lib/events/emit";
import { labEnabled } from "@/lib/lab";

export const INFRA_NODES = [
  { key: "waf", label: "WAF", kind: "edge", posX: 250, posY: 0 },
  { key: "lb", label: "Load Balancer", kind: "network", posX: 250, posY: 90 },
  { key: "api", label: "API Gateway", kind: "service", posX: 250, posY: 180 },
  { key: "app", label: "Application", kind: "service", posX: 250, posY: 270 },
  { key: "auth", label: "Auth Service", kind: "service", posX: 60, posY: 270 },
  { key: "payment", label: "Payment Service", kind: "service", posX: 440, posY: 270 },
  { key: "admin", label: "Admin Service", kind: "service", posX: 60, posY: 360 },
  { key: "db", label: "Database", kind: "data", posX: 250, posY: 360 },
  { key: "logging", label: "Logging Service", kind: "data", posX: 440, posY: 360 },
];

const PERSONA_POOL = [
  { name: "Riverside Freelancers", persona: "SMB — invoicing heavy" },
  { name: "Delta Logistics", persona: "Enterprise — compliance focused" },
  { name: "Juno Studios", persona: "Startup — rapid growth" },
  { name: "Harbor Clinic", persona: "SMB — security sensitive" },
  { name: "Nimbus Retail", persona: "Mid-market — seasonal spikes" },
];

export interface CreateCompanyInput {
  name: string;
  mission: string;
  industry: string;
  personality?: string;
  autonomy?: string;
  cash?: number;
  ownerId: string;
  isDemo?: boolean;
}

export async function createCompany(input: CreateCompanyInput) {
  const company = await prisma.company.create({
    data: {
      name: input.name,
      mission: input.mission,
      industry: input.industry,
      personality: input.personality ?? "balanced",
      autonomy: input.autonomy ?? "BALANCED",
      cash: input.cash ?? 500000,
      ownerId: input.ownerId,
      isDemo: input.isDemo ?? false,
      status: "BUILDING",
      securityScore: 58,
    },
  });

  // Owner membership (multi-tenant role grant).
  await prisma.workspaceMember.create({
    data: { userId: input.ownerId, companyId: company.id, role: "OWNER" },
  });

  await provisionWorkspace(company.id, company.name);

  await emitEvent({
    companyId: company.id,
    type: "COMPANY_UPDATED",
    actor: "system",
    level: "success",
    message: `${company.name} founded. ${AGENT_DEFS.length} AI employees hired.`,
  });

  return company;
}

/**
 * Staff and equip a workspace: agents with role permissions, infra topology,
 * sprint, code workspace, sample customers, founding timeline entry. Used on
 * creation and when a demo workspace is reset to its baseline.
 */
export async function provisionWorkspace(companyId: string, name: string, db: Pick<typeof prisma, "agent" | "infrastructureNode" | "sprint" | "codeWorkspace" | "customer" | "timelineEvent"> = prisma) {
  // Instantiate the AI employees with their role-based tool permissions.
  await db.agent.createMany({
    data: AGENT_DEFS.map((d) => ({
      companyId,
      key: d.key,
      name: d.name,
      role: d.role,
      avatar: d.avatar,
      color: d.color,
      personality: d.personality,
      status: "IDLE",
      permissions: JSON.stringify(permissionsFor(d.key)),
    })),
  });

  // Infrastructure topology.
  await db.infrastructureNode.createMany({
    data: INFRA_NODES.map((n) => ({
      companyId,
      key: n.key,
      label: n.label,
      kind: n.kind,
      posX: n.posX,
      posY: n.posY,
    })),
  });

  // A default sprint + code workspace.
  await db.sprint.create({
    data: { companyId, name: "Sprint 1", startDay: 0, endDay: 14 },
  });
  await db.codeWorkspace.create({
    data: {
      companyId,
      name: "project",
      files: JSON.stringify(defaultWorkspaceFiles(name)),
    },
  });

  // Simulation lab only: seed fictional customers for the company simulator.
  if (!labEnabled()) {
    await db.timelineEvent.create({ data: { companyId, title: `${name} workspace created`, kind: "founding", simDay: 0 } });
    return;
  }
  const picks = PERSONA_POOL.slice(0, 3);
  await db.customer.createMany({
    data: picks.map((p) => ({
      companyId,
      name: p.name,
      persona: p.persona,
      mrr: 0,
      status: "TRIAL",
    })),
  });

  await db.timelineEvent.create({
    data: { companyId, title: `${name} founded`, kind: "founding", simDay: 0 },
  });
}

function defaultWorkspaceFiles(name: string): Record<string, string> {
  return {
    "README.md": `# ${name}\n\nSimulated product repository managed by AURA agents.\n`,
    "src/index.ts": `// Entry point for ${name}\nexport function main() {\n  console.log("${name} starting...");\n}\n`,
    "src/api/health.ts": `export function health() {\n  return { status: "ok", ts: Date.now() };\n}\n`,
    "package.json": `{\n  "name": "${name.toLowerCase().replace(/\\s+/g, "-")}",\n  "version": "0.1.0"\n}\n`,
  };
}
