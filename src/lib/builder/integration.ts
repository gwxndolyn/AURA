/**
 * Integration intelligence service (AURA V13): persists the system graph per
 * product commit, selects regression tests from it, and records the
 * cross-component investigation of each failed attempt — including the
 * single, deduplicated remediation and its final outcome.
 *
 * Test selection policy (conservative by design):
 *   - targeted = tests covering changed files, their dependents, routes they
 *     handle, and pages calling those routes (graphImpact)
 *   - the FULL suite still runs as the gate for every attempt; the targeted
 *     run is an additional fast first signal, never a substitute
 *   - the plan is recorded with its confidence and the reasons it would fall
 *     back to the full suite only (low confidence, high risk, schema/deps)
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { log } from "@/lib/observability/log";
import type { CodeIndexData } from "./intel";
import { buildGraph, graphImpact, integrationFindings, type SystemGraph, type ContractFinding, type ImpactReport } from "./graph";
import { diagnose, type Diagnosis } from "./diagnose";

export async function snapshotGraph(args: { companyId: string; productId: string; sha: string; index: CodeIndexData; files: Record<string, string>; envProvided?: string[]; observed?: Parameters<typeof buildGraph>[0]["observed"] }) {
  try {
    const items = await prisma.backlogItem.findMany({ where: { productId: args.productId, companyId: args.companyId, level: { in: ["TASK", "REPAIR"] } }, select: { key: true, title: true, requirements: true, files: true, buildId: true } });
    const builds = await prisma.build.findMany({ where: { companyId: args.companyId, id: { in: items.map((i) => i.buildId).filter(Boolean) as string[] }, status: "VERIFIED" }, select: { id: true, changed: true } });
    const graph = buildGraph({ sha: args.sha, index: args.index, files: args.files, observed: args.observed, items: items.map((i) => ({ key: i.key, title: i.title, requirements: parseJSON<string[]>(i.requirements, []), plannedFiles: parseJSON<string[]>(i.files, []), verifiedFiles: parseJSON<string[]>(builds.find((b) => b.id === i.buildId)?.changed ?? "[]", []).map((c) => c.replace(/^\S+\s+/, "")) })) });
    const findings = integrationFindings(graph, args.index, args.files, { provided: args.envProvided });
    await prisma.systemGraphSnapshot.upsert({ where: { productId_sha: { productId: args.productId, sha: args.sha } }, create: { companyId: args.companyId, productId: args.productId, sha: args.sha, data: JSON.stringify(graph), findings: JSON.stringify(findings) }, update: { data: JSON.stringify(graph), findings: JSON.stringify(findings) } });
    const old = await prisma.systemGraphSnapshot.findMany({ where: { productId: args.productId, companyId: args.companyId }, orderBy: { createdAt: "desc" }, skip: 10, select: { id: true } });
    if (old.length) await prisma.systemGraphSnapshot.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    return { graph, findings };
  } catch (e) {
    log("warn", "graph.snapshot_failed", { productId: args.productId, error: (e as Error).message });
    const graph = buildGraph({ sha: args.sha, index: args.index, files: args.files });
    return { graph, findings: integrationFindings(graph, args.index, args.files, { provided: args.envProvided }) };
  }
}

export interface TestSelection { changed: string[]; selected: string[]; impact: Omit<ImpactReport, "components"> & { components: number }; confidence: string; fullSuite: true; targetedOnlyAllowed: boolean; why: string[] }

export function selectTests(graph: SystemGraph, index: CodeIndexData, changed: string[], risk: string): TestSelection {
  const imp = graphImpact(graph, index, changed);
  const why = [...imp.reasons];
  const targetedOnlyAllowed = imp.confidence === "high" && risk === "LOW" && imp.tests.length > 0;
  if (risk === "HIGH") why.push("high-risk change: full suite required");
  if (!targetedOnlyAllowed) why.push("full suite runs (conservative fallback)");
  else why.push("full suite still runs as the gate; targeted tests give the first signal");
  return { changed, selected: imp.tests, impact: { ...imp, components: imp.components.length }, confidence: imp.confidence, fullSuite: true, targetedOnlyAllowed, why };
}

/**
 * Investigate a failed attempt across components and persist the result.
 * Idempotent per (build, attempt). Returns the diagnosis for the engine's
 * repair brief and whether the cause is unavailable infrastructure.
 */
export async function investigate(args: { companyId: string; productId: string; buildId: string; itemKey: string; attempt: number; graph: SystemGraph; contracts: ContractFinding[]; changed: string[]; browser?: Parameters<typeof diagnose>[0]["browser"]; requirements: string[] }): Promise<Diagnosis> {
  const defects = await prisma.defect.findMany({ where: { buildId: args.buildId, companyId: args.companyId, lastAttempt: args.attempt } });
  const outputs = await prisma.commandRun.findMany({ where: { id: { in: defects.map((d) => d.commandRunId) }, companyId: args.companyId }, select: { id: true, output: true } });
  const d = diagnose({ graph: args.graph, contracts: args.contracts, changed: args.changed, browser: args.browser ?? null, defects: defects.map((x) => ({ signature: x.signature, category: x.category, title: x.title, files: parseJSON<string[]>(x.files, []), failingTests: parseJSON<string[]>(x.failingTests, []), output: outputs.find((o) => o.id === x.commandRunId)?.output ?? "" })) });
  const data = { symptoms: JSON.stringify(d.symptoms), hypotheses: JSON.stringify(d.hypotheses.slice(0, 6)), rootCause: d.rootCause?.statement ?? "", category: d.rootCause?.category ?? (d.ambiguous ? "ambiguous" : "unknown"), origin: d.rootCause?.origin ?? "", ambiguous: d.ambiguous, infrastructure: d.infrastructure, status: d.infrastructure ? "LIMITATION" : "OPEN", requirements: JSON.stringify(args.requirements), remediationKey: d.infrastructure ? null : args.itemKey };
  await prisma.investigation.upsert({ where: { buildId_attempt: { buildId: args.buildId, attempt: args.attempt } }, create: { companyId: args.companyId, productId: args.productId, buildId: args.buildId, itemKey: args.itemKey, attempt: args.attempt, ...data }, update: data }).catch((e) => log("warn", "investigation.persist_failed", { error: (e as Error).message }));
  // Earlier open investigations of this run: still unresolved → REPAIRING (one remediation, the run itself).
  await prisma.investigation.updateMany({ where: { buildId: args.buildId, attempt: { lt: args.attempt }, status: "OPEN" }, data: { status: "REPAIRING" } });
  return d;
}

/** When a run finishes: its investigations are RESOLVED (verified) or UNRESOLVED; limitations stay LIMITATION. */
export async function settleInvestigations(companyId: string, buildId: string, verified: boolean) {
  await prisma.investigation.updateMany({ where: { companyId, buildId, status: { in: ["OPEN", "REPAIRING"] } }, data: { status: verified ? "RESOLVED" : "UNRESOLVED", resolvedAt: new Date() } });
}

/** Repair brief from a diagnosis: root cause + smallest change, or the limitation (no code change). */
export function diagnosisText(d: Diagnosis) {
  if (!d.hypotheses.length) return "";
  if (d.infrastructure) return `# Investigation: infrastructure limitation\n${d.summary}\nDo NOT change application code to work around this. ${d.rootCause?.fix.change ?? ""}`;
  const h = d.rootCause;
  const lines = d.hypotheses.slice(0, 3).map((x) => `- ${x.id} [${x.category}, score ${x.score}] ${x.statement} — explains ${x.explains.join(", ") || "nothing"}${x.unexplained.length ? `; not ${x.unexplained.join(", ")}` : ""}`);
  return `# Investigation (cross-component, evidence-ranked)\nSymptoms: ${d.symptoms.map((s) => `${s.id} ${s.detail}`.slice(0, 160)).join(" | ")}\nHypotheses:\n${lines.join("\n")}\n${h ? `Most supported root cause: ${h.statement}\nSmallest change: ${h.fix.change}${h.fix.files.length ? ` (files: ${h.fix.files.join(", ")})` : ""}. Do not edit unrelated components to hide secondary errors.` : `Ambiguous — run these diagnostics first: ${d.hypotheses.slice(0, 2).flatMap((x) => x.diagnostics).join("; ")}`}`;
}
