import { prisma } from "@/lib/db";
import { clamp, seededRandom, hashString } from "@/lib/utils";
import { emitEvent } from "@/lib/events/emit";

/**
 * Simulation engine. Advances the company one simulated day: updates customers,
 * revenue, expenses, cash, uptime, infra metrics and records a Metric snapshot.
 * Deterministic per (companyId, simDay) so replays are stable.
 */

export async function tickDay(companyId: string): Promise<void> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return;

  const day = company.simDay + 1;
  const rnd = seededRandom(hashString(companyId) + day);

  // Count DONE tasks as a proxy for product maturity -> growth.
  const doneTasks = await prisma.task.count({ where: { companyId, status: "DONE" } });
  const activeIncidents = await prisma.incident.count({ where: { companyId, status: "ACTIVE" } });

  const maturity = clamp(doneTasks / 10, 0, 1); // 0..1
  const underAttack = company.status === "UNDER_ATTACK" || company.status === "INCIDENT";

  // Customer growth scales with product maturity & reputation, hurt by incidents.
  const growthRate = (0.02 + maturity * 0.06) * (company.reputation / 60);
  const churnRate = 0.01 + activeIncidents * 0.02 + (company.securityScore < 50 ? 0.015 : 0);
  const gained = Math.round((company.customers * growthRate + maturity * 8 + 1) * (0.6 + rnd() * 0.8));
  const churned = Math.round(company.customers * churnRate);
  const customers = clamp(company.customers + gained - churned, 0, 10_000_000);

  // Revenue: $29 ARPU/mo -> per-day; expenses scale with team + infra.
  const arpuDay = 29 / 30;
  const revenue = customers * arpuDay;
  const expenses = 1200 + customers * 0.15 + (underAttack ? 400 : 0);
  const cash = company.cash + revenue - expenses;

  const uptime = clamp(
    underAttack ? company.uptime - (0.5 + rnd()) : Math.min(100, company.uptime + 0.1),
    80,
    100,
  );
  const reputation = clamp(
    company.reputation + (activeIncidents ? -1.5 : 0.4) + (maturity > 0.5 ? 0.3 : 0),
    0,
    100,
  );
  const technicalDebt = clamp(
    company.technicalDebt + (rnd() < 0.3 ? 1 : 0) - (doneTasks % 5 === 0 ? 1 : 0),
    0,
    100,
  );
  const valuation = revenue * 365 * 6 + customers * 120;

  await prisma.company.update({
    where: { id: companyId },
    data: {
      simDay: day,
      customers,
      revenue,
      expenses,
      cash,
      uptime,
      reputation,
      technicalDebt,
      valuation,
    },
  });

  // Infra metrics drift; attacks spike CPU/latency/errors.
  const nodes = await prisma.infrastructureNode.findMany({ where: { companyId } });
  for (const n of nodes) {
    const attacked = n.status === "UNDER_ATTACK";
    await prisma.infrastructureNode.update({
      where: { id: n.id },
      data: {
        cpu: clamp(n.cpu + (attacked ? 20 : (rnd() - 0.5) * 8), 5, 99),
        memory: clamp(n.memory + (rnd() - 0.5) * 6, 10, 95),
        latencyMs: clamp(n.latencyMs + (attacked ? 60 : (rnd() - 0.5) * 20), 10, 1200),
        errorRate: clamp(n.errorRate + (attacked ? 2 : (rnd() - 0.5) * 0.3), 0, 40),
        rps: clamp(n.rps + (rnd() - 0.5) * 40, 5, 5000),
      },
    });
  }

  await prisma.metric.create({
    data: {
      companyId,
      simDay: day,
      revenue,
      customers,
      cash,
      uptime,
      securityScore: company.securityScore,
      incidents: activeIncidents,
      technicalDebt,
    },
  });

  // Occasional customer events keep the environment alive.
  if (rnd() < 0.5) {
    await maybeCustomerEvent(companyId, rnd);
  }

  await emitEvent({
    companyId,
    type: "SIM_TICK",
    actor: "system",
    message: `Day ${day}: ${customers} customers, $${Math.round(revenue)}/day revenue`,
    simDay: day,
    persist: false,
    meta: { day, customers, revenue, cash },
  });
}

async function maybeCustomerEvent(companyId: string, rnd: () => number) {
  const events = [
    { type: "signup", msg: "New customer signed up", level: "success" as const },
    { type: "feature-request", msg: "Customer requested a new feature", level: "info" as const },
    { type: "support", msg: "Support ticket opened", level: "info" as const },
    { type: "praise", msg: "Customer left positive feedback", level: "success" as const },
    { type: "complaint", msg: "Customer reported slow performance", level: "warning" as const },
  ];
  const e = events[Math.floor(rnd() * events.length)];
  await emitEvent({
    companyId,
    type: "COMPANY_UPDATED",
    actor: "support",
    level: e.level,
    message: `${e.msg} (simulated)`,
    persist: false,
  });
}

export async function advanceDays(companyId: string, days: number) {
  for (let i = 0; i < days; i++) {
    await tickDay(companyId);
  }
}
