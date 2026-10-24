/**
 * Seed script: creates a fictional, clearly-labeled SIMULATED company "NOVA PAY"
 * so the dashboard looks alive immediately. All data here is simulated demo data.
 */
import { PrismaClient } from "@prisma/client";
import { AGENT_DEFS } from "../src/lib/agents/definitions";
import { INFRA_NODES } from "../src/lib/company/provision";
import { permissionsFor } from "../src/lib/agents/permissions";

const prisma = new PrismaClient();

async function main() {
  const email = "founder@aura.local";
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: "Founder" },
  });

  // Clean previous demo company of the same name to keep seeds idempotent.
  await prisma.company.deleteMany({ where: { name: "NOVA PAY", isDemo: true } });

  const company = await prisma.company.create({
    data: {
      name: "NOVA PAY",
      mission: "AI-powered expense management for modern teams.",
      industry: "Fintech",
      personality: "ambitious",
      autonomy: "BALANCED",
      isDemo: true,
      status: "OPERATING",
      cash: 712000,
      revenue: 4210,
      expenses: 1850,
      customers: 142,
      valuation: 9_200_000,
      reputation: 68,
      uptime: 99.2,
      securityScore: 61,
      technicalDebt: 18,
      velocity: 28,
      simDay: 12,
      ownerId: user.id,
    },
  });

  // Agents (8+ AI employees).
  await prisma.agent.createMany({
    data: AGENT_DEFS.map((d, i) => ({
      companyId: company.id,
      key: d.key,
      name: d.name,
      role: d.role,
      avatar: d.avatar,
      color: d.color,
      personality: d.personality,
      status: "IDLE",
      permissions: JSON.stringify(permissionsFor(d.key)),
      tasksDone: [4, 6, 3, 5, 7, 4, 9, 2, 3, 3, 5, 6][i] ?? 2,
      tokensIn: 12000 + i * 3400,
      tokensOut: 4800 + i * 1500,
      cost: 0.12 + i * 0.05,
    })),
  });
  const agents = await prisma.agent.findMany({ where: { companyId: company.id } });
  const byKey = new Map(agents.map((a) => [a.key, a]));

  // Infrastructure.
  await prisma.infrastructureNode.createMany({
    data: INFRA_NODES.map((n, i) => ({
      companyId: company.id,
      key: n.key,
      label: n.label,
      kind: n.kind,
      posX: n.posX,
      posY: n.posY,
      cpu: 18 + i * 4,
      memory: 30 + i * 3,
      latencyMs: 35 + i * 6,
      errorRate: 0.1 + i * 0.05,
      rps: 80 + i * 25,
    })),
  });

  // Sprint + projects (3).
  const sprint = await prisma.sprint.create({
    data: { companyId: company.id, name: "Sprint 2", startDay: 7, endDay: 21 },
  });
  const projects = await Promise.all([
    prisma.project.create({ data: { companyId: company.id, name: "MVP Launch", description: "Core expense management flows." } }),
    prisma.project.create({ data: { companyId: company.id, name: "Security Hardening", description: "Close findings, improve posture." } }),
    prisma.project.create({ data: { companyId: company.id, name: "Growth Experiments", description: "Onboarding + conversion." } }),
  ]);

  // Tasks (12).
  const taskSpecs: [string, string, string, string, string][] = [
    ["Expense capture API", "Build endpoint to record expenses with validation.", "HIGH", "backend-engineer", "DONE"],
    ["Receipt OCR integration", "Extract line items from uploaded receipts.", "MEDIUM", "backend-engineer", "IN_PROGRESS"],
    ["Approvals workflow UI", "Manager approval queue and actions.", "HIGH", "frontend-engineer", "DONE"],
    ["Reporting dashboard", "Spend breakdown charts.", "MEDIUM", "frontend-engineer", "REVIEW"],
    ["JWT auth hardening", "Rotate secrets, enforce expiry.", "CRITICAL", "backend-engineer", "TESTING"],
    ["Rate limiting on API", "Protect public endpoints.", "HIGH", "devops", "PLANNED"],
    ["E2E signup test suite", "Cover onboarding happy path.", "MEDIUM", "qa-engineer", "DONE"],
    ["Staging deploy pipeline", "Automate build/test/deploy.", "MEDIUM", "devops", "DONE"],
    ["IDOR fix on /users", "Enforce object ownership checks.", "CRITICAL", "backend-engineer", "DONE"],
    ["Threat model refresh", "Re-model after new services.", "HIGH", "security-engineer", "IN_PROGRESS"],
    ["Churn analysis", "Identify at-risk cohorts.", "LOW", "data-analyst", "BACKLOG"],
    ["Onboarding emails", "Lifecycle messaging.", "LOW", "product-manager", "BACKLOG"],
  ];
  for (let i = 0; i < taskSpecs.length; i++) {
    const [title, description, priority, assignee, status] = taskSpecs[i];
    await prisma.task.create({
      data: {
        companyId: company.id,
        projectId: projects[i % projects.length].id,
        sprintId: sprint.id,
        assigneeId: byKey.get(assignee)?.id,
        title,
        description,
        priority,
        status,
        estimate: 3 + (i % 5),
        actual: status === "DONE" ? 3 + (i % 4) : 0,
        acceptance: JSON.stringify([
          { text: "Implementation complete", met: status === "DONE" },
          { text: "Tests pass", met: status === "DONE" },
        ]),
        completedAt: status === "DONE" ? new Date() : null,
      },
    });
  }

  // Deployments (2).
  await prisma.deployment.createMany({
    data: [
      {
        companyId: company.id,
        env: "production",
        version: "v0.3.0",
        commit: "a1b2c3d",
        status: "SUCCESS",
        stage: "HEALTH_CHECK",
        durationMs: 4200,
        stages: JSON.stringify([
          { name: "BUILD", status: "SUCCESS", durationMs: 900 },
          { name: "TEST", status: "SUCCESS", durationMs: 1200 },
          { name: "SECURITY_SCAN", status: "SUCCESS", durationMs: 700 },
          { name: "DEPLOY", status: "SUCCESS", durationMs: 900 },
          { name: "HEALTH_CHECK", status: "SUCCESS", durationMs: 500 },
        ]),
      },
      {
        companyId: company.id,
        env: "staging",
        version: "v0.4.0-rc1",
        commit: "e4f5a6b",
        status: "FAILED",
        stage: "TEST",
        durationMs: 2100,
        stages: JSON.stringify([
          { name: "BUILD", status: "SUCCESS", durationMs: 900 },
          { name: "TEST", status: "FAILED", durationMs: 1200 },
        ]),
      },
    ],
  });

  // Customers (5).
  await prisma.customer.createMany({
    data: [
      { companyId: company.id, name: "Riverside Freelancers", persona: "SMB", mrr: 290, satisfaction: 82, status: "ACTIVE" },
      { companyId: company.id, name: "Delta Logistics", persona: "Enterprise", mrr: 1900, satisfaction: 74, status: "ACTIVE" },
      { companyId: company.id, name: "Juno Studios", persona: "Startup", mrr: 90, satisfaction: 88, status: "ACTIVE" },
      { companyId: company.id, name: "Harbor Clinic", persona: "SMB", mrr: 290, satisfaction: 61, status: "ACTIVE" },
      { companyId: company.id, name: "Nimbus Retail", persona: "Mid-market", mrr: 0, satisfaction: 40, status: "CHURNED" },
    ],
  });

  // Security findings (5).
  const findingSpecs: [string, string, string, string, string, string, number][] = [
    ["AURA-2026-001", "Improper authorization check", "authorization", "HIGH", "VERIFIED", "User API", 7.5],
    ["AURA-2026-002", "Reflected XSS in report view", "application-security", "MEDIUM", "FIXED", "Application", 5.9],
    ["AURA-2026-003", "Weak password policy", "authentication", "MEDIUM", "OPEN", "Auth Service", 5.3],
    ["AURA-2026-004", "Vulnerable dependency (lodash)", "dependencies", "HIGH", "OPEN", "Application", 7.1],
    ["AURA-2026-005", "Verbose error messages leak stack", "application-security", "LOW", "OPEN", "API Gateway", 3.1],
  ];
  for (const [code, title, category, severity, status, affected, cvss] of findingSpecs) {
    await prisma.securityFinding.create({
      data: {
        companyId: company.id,
        code,
        title,
        category,
        severity,
        status,
        affected,
        cvss,
        discoveredBy: "Ghost",
        fixedBy: ["VERIFIED", "FIXED"].includes(status) ? "Atlas" : null,
        verifiedBy: status === "VERIFIED" ? "Iris" : null,
        description: `Simulated finding: ${title} affecting ${affected}.`,
      },
    });
  }

  // Historical incidents (2).
  await prisma.incident.createMany({
    data: [
      {
        companyId: company.id,
        number: 1041,
        title: "Simulated IDOR on User API",
        severity: "HIGH",
        status: "RESOLVED",
        attackType: "Insecure Direct Object Reference",
        target: "User API",
        summary: "Simulated unauthorized access to other users' records; contained and patched.",
        timeline: JSON.stringify([
          { ts: new Date(Date.now() - 86400000).toISOString(), actor: "Ghost", message: "Recon of /users endpoint" },
          { ts: new Date(Date.now() - 86300000).toISOString(), actor: "Shield", message: "Detected anomalous access pattern" },
          { ts: new Date(Date.now() - 86200000).toISOString(), actor: "Atlas", message: "Added ownership check & patch" },
          { ts: new Date(Date.now() - 86100000).toISOString(), actor: "Iris", message: "Verified fix" },
        ]),
        evidence: JSON.stringify(["Simulated request accessing user id != session user"]),
        resolvedAt: new Date(Date.now() - 86000000),
      },
      {
        companyId: company.id,
        number: 1042,
        title: "Simulated XSS in report view",
        severity: "MEDIUM",
        status: "RESOLVED",
        attackType: "Reflected XSS",
        target: "Application",
        summary: "Simulated script injection in report filter; sanitized input and patched.",
        timeline: JSON.stringify([
          { ts: new Date(Date.now() - 43200000).toISOString(), actor: "Ghost", message: "Injected payload in filter param" },
          { ts: new Date(Date.now() - 43100000).toISOString(), actor: "Shield", message: "WAF signature match" },
          { ts: new Date(Date.now() - 43000000).toISOString(), actor: "Nova", message: "Added output encoding" },
          { ts: new Date(Date.now() - 42900000).toISOString(), actor: "Iris", message: "Verified fix" },
        ]),
        resolvedAt: new Date(Date.now() - 42800000),
      },
    ],
  });

  // Metric history for charts.
  for (let d = 1; d <= 12; d++) {
    await prisma.metric.create({
      data: {
        companyId: company.id,
        simDay: d,
        revenue: 200 + d * 320 + Math.round(Math.sin(d) * 80),
        customers: 10 + d * 11,
        cash: 712000 - d * 1200 + d * 300,
        uptime: 99.9 - (d === 7 ? 0.9 : 0.1),
        securityScore: 50 + Math.min(12, d),
        incidents: d === 7 ? 1 : 0,
        technicalDebt: 24 - Math.floor(d / 3),
      },
    });
  }

  // Timeline + a few events + a decision.
  await prisma.timelineEvent.createMany({
    data: [
      { companyId: company.id, title: "NOVA PAY founded", kind: "founding", simDay: 0 },
      { companyId: company.id, title: "First customer onboarded", kind: "customer", simDay: 2 },
      { companyId: company.id, title: "Deployed v0.3.0", kind: "deployment", simDay: 6 },
      { companyId: company.id, title: "Resolved IDOR incident", kind: "incident", simDay: 7 },
      { companyId: company.id, title: "Reached 100 customers", kind: "milestone", simDay: 10 },
    ],
  });

  await prisma.decision.create({
    data: {
      companyId: company.id,
      question: "Should we delay launch to harden security?",
      options: JSON.stringify([
        { label: "Launch now", pros: ["Faster revenue"], cons: ["Open findings"] },
        { label: "Harden first", pros: ["Lower risk"], cons: ["1 week delay"] },
      ]),
      evidence: JSON.stringify(["Security score 61/100", "2 open high findings", "Runway 18 months"]),
      consulted: JSON.stringify(["ceo", "security-engineer", "product-manager"]),
      choice: "Harden first",
      rationale: "With two open high-severity findings and healthy runway, reducing risk outweighs a one-week delay.",
      status: "DECIDED",
    },
  });

  await prisma.codeWorkspace.create({
    data: {
      companyId: company.id,
      name: "nova-pay",
      files: JSON.stringify({
        "README.md": "# NOVA PAY\n\nSimulated expense management product managed by AURA agents.\n",
        "src/index.ts": "export function main() {\n  console.log('NOVA PAY booting');\n}\n",
        "src/api/expenses.ts":
          "import { z } from 'zod';\n\nconst Expense = z.object({ amount: z.number().positive(), category: z.string() });\n\nexport function createExpense(input: unknown) {\n  const data = Expense.parse(input);\n  return { id: crypto.randomUUID(), ...data };\n}\n",
        "src/auth/token.ts":
          "export function requireAuth(handler) {\n  return (req, res) => {\n    const token = req.headers.authorization?.replace('Bearer ', '');\n    if (!token) return res.status(401).json({ error: 'missing token' });\n    return handler(req, res);\n  };\n}\n",
      }),
    },
  });

  console.log(`✓ Seeded SIMULATED company "NOVA PAY" (${company.id})`);
  console.log(`  ${AGENT_DEFS.length} agents, 12 tasks, 3 projects, 2 deployments, 5 customers, 5 findings, 2 incidents.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
