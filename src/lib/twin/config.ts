/**
 * CEO configuration (simulated decisions). Changing it never changes real
 * worker limits, tool permissions, approvals or sandbox settings — those are
 * enforced elsewhere and are not read from here.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { parseJSON } from "@/lib/utils";
import { audit, emitEvent } from "@/lib/events/emit";
import { DEFAULT_DECISIONS, validateDecisions, simulate, type Decisions } from "./engine";
import { scenarioById } from "./scenarios";

export async function getConfig(companyId: string) {
  const row = await prisma.twinConfig.upsert({ where: { companyId }, create: { companyId, allocation: JSON.stringify(DEFAULT_DECISIONS.allocation), priorities: JSON.stringify(DEFAULT_DECISIONS.priorities), objectives: JSON.stringify(["Ship verified features on schedule", "Keep incidents short", "Close security findings within budget"]) }, update: {} });
  return {
    ...row,
    objectives: parseJSON<string[]>(row.objectives, []),
    allocation: parseJSON<Decisions["allocation"]>(row.allocation, DEFAULT_DECISIONS.allocation),
    priorities: parseJSON<Decisions["priorities"]>(row.priorities, DEFAULT_DECISIONS.priorities),
    capacity: parseJSON<Decisions["capacity"]>(row.capacity, {}),
    history: parseJSON<{ version: number; at: string; by: string; change: string }[]>(row.history, []),
  };
}

export function decisionsFromConfig(c: Awaited<ReturnType<typeof getConfig>>, extra: Partial<Decisions> = {}): Decisions {
  return { allocation: c.allocation, priorities: c.priorities, capacity: c.capacity, verificationGate: true, riskPolicy: c.riskPolicy as Decisions["riskPolicy"], ...extra };
}

/**
 * Preview the impact of a proposed config change on a scenario (deterministic,
 * nothing persisted): current vs proposed metrics.
 */
export function previewImpact(scenario: string, current: Decisions, proposed: Decisions) {
  const sc = scenarioById(scenario);
  if (!sc) throw new ApiError("Unknown scenario", 422);
  const a = simulate(sc.initial, current, sc.seed).result;
  const b = simulate(sc.initial, proposed, sc.seed).result;
  const keys = ["delivered", "onTime", "escapedUnverified", "avgWaitTicks", "budgetUsed", "riskExposure", "incidentDowntime"] as const;
  return { scenario, current: Object.fromEntries(keys.map((k) => [k, a.metrics[k]])), proposed: Object.fromEntries(keys.map((k) => [k, b.metrics[k]])), simulated: true };
}

export async function updateConfig(companyId: string, actor: string, patch: { allocation?: Decisions["allocation"]; priorities?: Decisions["priorities"]; capacity?: Decisions["capacity"]; riskPolicy?: Decisions["riskPolicy"]; budgetUsd?: number; objectives?: string[] }, expectedVersion: number) {
  const cur = await getConfig(companyId);
  if (cur.version !== expectedVersion) throw new ApiError(`Configuration changed since you loaded it (v${expectedVersion} → v${cur.version}); reload and retry`, 409);
  const next = decisionsFromConfig(cur, { ...(patch.allocation ? { allocation: patch.allocation } : {}), ...(patch.priorities ? { priorities: patch.priorities } : {}), ...(patch.capacity ? { capacity: patch.capacity } : {}), ...(patch.riskPolicy ? { riskPolicy: patch.riskPolicy } : {}) });
  const errs = validateDecisions(next);
  if (errs.length) throw new ApiError(errs.join("; "), 422);
  const changes: string[] = [];
  if (patch.allocation) changes.push(`allocation ${Object.entries(patch.allocation).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(", ")}`);
  if (patch.priorities) changes.push(`priorities ${patch.priorities.join(" > ")}`);
  if (patch.capacity) changes.push(`capacity ${Object.entries(patch.capacity).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (patch.riskPolicy) changes.push(`risk policy ${patch.riskPolicy}`);
  if (patch.budgetUsd !== undefined) changes.push(`budget $${patch.budgetUsd.toLocaleString()}`);
  if (patch.objectives) changes.push("objectives updated");
  const version = cur.version + 1;
  const res = await prisma.twinConfig.updateMany({
    where: { companyId, version: cur.version },
    data: {
      ...(patch.allocation ? { allocation: JSON.stringify(patch.allocation) } : {}),
      ...(patch.priorities ? { priorities: JSON.stringify(patch.priorities) } : {}),
      ...(patch.capacity ? { capacity: JSON.stringify(patch.capacity) } : {}),
      ...(patch.riskPolicy ? { riskPolicy: patch.riskPolicy } : {}),
      ...(patch.budgetUsd !== undefined ? { budgetUsd: patch.budgetUsd } : {}),
      ...(patch.objectives ? { objectives: JSON.stringify(patch.objectives) } : {}),
      version,
      updatedBy: actor,
      history: JSON.stringify([...cur.history, { version, at: new Date().toISOString(), by: actor, change: changes.join("; ") }].slice(-50)),
    },
  });
  if (res.count !== 1) throw new ApiError("Configuration changed concurrently; reload and retry", 409);
  await audit(companyId, actor, "TWIN_CONFIG_UPDATED", `v${version}`, changes.join("; "));
  await emitEvent({ companyId, type: "COMPANY_UPDATED", actor: "ceo", message: `[SIMULATION] CEO decision v${version}: ${changes.join("; ")}`, meta: { simulated: true, twinConfigVersion: version }, ops: { severity: "info", source: "ops", resourceType: "simulation", resourceId: `config:v${version}` } });
  return getConfig(companyId);
}
