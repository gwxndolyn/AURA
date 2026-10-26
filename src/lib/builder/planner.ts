/**
 * Adaptive planning for one engineering run: gathers the REAL evidence the
 * policy in adaptive.ts decides from (repository snapshot, static dependency
 * graph, open defects, earlier runs, recent outcomes, project execution
 * policy, configured models), produces the execution plan, and persists it on
 * the Build (`executionPlan`). Strategy changes during the run are appended to
 * the same record by `recordAdjustment` — the workspace shows exactly what was
 * decided, when and why.
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { configuredModels } from "@/lib/ai/claude";
import { permissionsFor } from "@/lib/agents/permissions";
import { capabilityFor } from "@/lib/agents/capabilities";
import { dependentsOf, type CodeIndexData } from "./intel";
import {
  classifyTask, chooseStrategy, verificationRequirements, verificationStatus, toolPlan, routeModel, collaborationValue,
  ADAPTIVE_POLICIES, DEFAULT_ADAPTIVE_POLICY, DEFAULT_MODEL_POLICY,
  type Classification, type StrategyDecision, type CheckId, type ModelPolicy, type Strategy, type AdjustDecision,
} from "./adaptive";
import type { Risk } from "./orchestrator";

export interface ExecutionPolicy { adaptivePolicy?: string; pinnedStrategy?: Strategy; mandatoryChecks?: CheckId[]; allowedProviders?: string[]; pinnedModels?: string[]; fallback?: "fallback" | "fail" }

export interface ExecutionPlanRecord {
  policy: string;
  adaptive: boolean;
  createdAt: string;
  classification: Classification;
  strategy: StrategyDecision;
  owner: { agent: string; why: string; limitation?: string };
  verification: { id: CheckId; why: string }[];
  tools: { tool: string; why: string; available: boolean; permitted: boolean }[];
  model: { tier: string; model: string | null; fallbackUsed: boolean; reasons: string[]; blocker: string | null };
  collaboration: { worth: boolean; why: string };
  adjustments: (AdjustDecision & { attempt: number; at: string; applied: string })[];
  verificationStatus?: { attempt: number } & ReturnType<typeof verificationStatus>;
}

const EXTERNAL = /\b(stripe|resend|sendgrid|twilio|openai|anthropic|slack|github api|google maps|mapbox|auth0|firebase|supabase|s3|aws|paypal|shopify|airtable|notion api)\b/gi;

export async function planExecution(args: {
  companyId: string; productId: string; buildId: string;
  item: { key: string; kind: string; level: string; title: string; description: string; acceptance: string[]; files: string[]; dependsOn: string[]; risk: string };
  assessed: { risk: Risk; reasons: string[] };
  owner: string; ownerTier: "FAST" | "STANDARD" | "REASONING"; reviewers: string[];
  index: CodeIndexData; ui: boolean;
  scripts: Record<string, string>;
}): Promise<ExecutionPlanRecord> {
  const product = await prisma.product.findFirst({ where: { id: args.productId, companyId: args.companyId }, select: { executionPolicy: true } });
  const pol = parseJSON<ExecutionPolicy>(product?.executionPolicy, {});
  const policyId = pol.adaptivePolicy && ADAPTIVE_POLICIES[pol.adaptivePolicy] ? pol.adaptivePolicy : process.env.AURA_ADAPTIVE_POLICY && ADAPTIVE_POLICIES[process.env.AURA_ADAPTIVE_POLICY] ? process.env.AURA_ADAPTIVE_POLICY : DEFAULT_ADAPTIVE_POLICY;
  const policy = ADAPTIVE_POLICIES[policyId];
  // Evidence (all scoped to this workspace + product).
  const [defects, priorRuns, history] = await Promise.all([
    prisma.defect.findMany({ where: { companyId: args.companyId, productId: args.productId, itemKey: { in: [args.item.key, args.item.key.replace(/\.R\d+$/, "")] }, status: { in: ["OPEN", "RECURRING", "ABANDONED"] } }, select: { category: true, occurrences: true, failingTests: true } }),
    prisma.build.findMany({ where: { companyId: args.companyId, productId: args.productId, itemKey: args.item.key, id: { not: args.buildId }, status: { in: ["VERIFIED", "FAILED", "BLOCKED"] } }, select: { status: true, attempt: true, stopReason: true } }),
    prisma.runOutcome.findMany({ where: { companyId: args.companyId, productId: args.productId, taskKind: args.item.kind }, orderBy: { createdAt: "desc" }, take: 20, select: { firstPassSuccess: true, outcome: true } }),
  ]);
  const repoFiles = args.index.files.map((f) => f.path);
  const text = `${args.item.title} ${args.item.description} ${args.item.acceptance.join(" ")}`;
  const externalApis = [...new Set([...text.matchAll(EXTERNAL)].map((m) => m[1].toLowerCase()))];
  const ext = (name: string) => args.index.files.some((f) => f.external.some((e) => e.toLowerCase().includes(name.split(" ")[0])));
  const classification = classifyTask({
    key: args.item.key, kind: args.item.kind, level: args.item.level, title: args.item.title, description: args.item.description, acceptance: args.item.acceptance, files: args.item.files, dependsOn: args.item.dependsOn,
    plannedRisk: args.item.risk, assessedRisk: args.assessed.risk, riskReasons: args.assessed.reasons,
    // An external API already imported by the code counts as a known file (no research needed).
    repoFiles: externalApis.every(ext) ? repoFiles : repoFiles,
    dependents: dependentsOf(args.index, args.item.files.filter((f) => repoFiles.includes(f))),
    openDefects: defects.map((d) => ({ category: d.category, occurrences: d.occurrences, failingTests: parseJSON<string[]>(d.failingTests, []) })),
    priorRuns: priorRuns.map((r) => ({ status: r.status, attempts: r.attempt + 1, stopReason: r.stopReason })),
    history, externalApis: externalApis.filter((e) => !ext(e)),
  });
  // Capability: the planned owner must be able to write code for this kind; record limitations honestly.
  const cap = capabilityFor(args.owner);
  const limitation = !cap ? `${args.owner} has no registered capability record` : !cap.canWriteCode && args.item.kind !== "DOCS" ? `${args.owner} cannot write code` : undefined;
  const parts = args.item.files.length > 2 ? groupParts(args.item.files) : [];
  const collab = collaborationValue(parts);
  const strategy: StrategyDecision = policy.adaptive
    ? chooseStrategy(classification, { owner: args.owner, reviewers: args.reviewers, browser: args.ui, parallelWorth: collab.worth, pinned: pol.pinnedStrategy })
    : chooseStrategy({ ...classification, risk: { value: "LOW", evidence: [] }, category: { value: "implementation", evidence: [] }, uncertainty: { value: "low", evidence: [] }, research: { value: false, evidence: [] }, complexity: { value: "low", evidence: [] }, collaboration: { value: "single", evidence: [] } }, { owner: args.owner, reviewers: args.reviewers, browser: args.ui, parallelWorth: false });
  if (!policy.adaptive) strategy.why = "baseline policy: one strategy for every task";
  const verification = verificationRequirements(classification, { mandatory: pol.mandatoryChecks, ui: args.ui, schemaChange: args.item.files.some((f) => /\.prisma$|migrations?\//.test(f)) });
  const tools = toolPlan(classification, { permitted: permissionsFor(args.owner) as string[], available: { browser: !!process.env.AURA_BROWSER_DISABLED ? false : true, "docs.research": false }, ui: args.ui, hasTypecheck: !!args.scripts.typecheck, hasLint: !!args.scripts.lint });
  const modelPolicy: ModelPolicy = { ...DEFAULT_MODEL_POLICY, allowedProviders: pol.allowedProviders ?? [], pinnedModels: pol.pinnedModels ?? [], fallback: pol.fallback ?? "fallback" };
  const wantTier = classification.risk.value === "HIGH" && args.owner.endsWith("-engineer") ? "REASONING" : args.ownerTier;
  const routed = routeModel({ tier: wantTier, needsTools: true, contextTokens: 30_000 }, configuredModels(), modelPolicy);
  const rec: ExecutionPlanRecord = {
    policy: policyId, adaptive: policy.adaptive, createdAt: new Date().toISOString(), classification, strategy,
    owner: { agent: args.owner, why: `${args.item.kind} task → ${args.owner} (capability registry: ${cap?.taskKinds.join("/") ?? "?"}; domains ${cap?.domains.join("/") ?? "?"})`, ...(limitation ? { limitation } : {}) },
    verification, tools,
    model: { tier: routed.chosen?.tier ?? wantTier, model: routed.chosen?.model ?? null, fallbackUsed: routed.fallbackUsed, reasons: routed.reasons, blocker: routed.blocker },
    collaboration: collab, adjustments: [],
  };
  await prisma.build.update({ where: { id: args.buildId }, data: { executionPlan: JSON.stringify(rec), adaptivePolicy: policyId } });
  return rec;
}

/** Group files into candidate parts by top-level area (e.g. public/ vs src/routes/). Used only to estimate collaboration value. */
function groupParts(files: string[]) {
  const by = new Map<string, string[]>();
  for (const f of files) {
    const k = f.startsWith("public/") ? "ui" : f.includes("/routes/") ? "api" : f.split("/").slice(0, 2).join("/");
    by.set(k, [...(by.get(k) ?? []), f]);
  }
  return [...by.entries()].map(([key, fs]) => ({ key, files: fs, dependsOn: key === "ui" && by.has("api") ? ["api"] : [] }));
}

export async function recordAdjustment(buildId: string, attempt: number, d: AdjustDecision, applied: string) {
  const b = await prisma.build.findUnique({ where: { id: buildId }, select: { executionPlan: true } });
  const rec = parseJSON<ExecutionPlanRecord>(b?.executionPlan, {} as ExecutionPlanRecord);
  if (!rec.strategy) return;
  rec.adjustments = [...(rec.adjustments ?? []), { ...d, attempt, at: new Date().toISOString(), applied }];
  await prisma.build.update({ where: { id: buildId }, data: { executionPlan: JSON.stringify(rec) } });
}

/** Required-vs-executed checks for the latest attempt (missing evidence stays "not_run"/"unavailable"). */
export async function recordVerification(buildId: string, attempt: number, status: ReturnType<typeof verificationStatus>) {
  const b = await prisma.build.findUnique({ where: { id: buildId }, select: { executionPlan: true } });
  const rec = parseJSON<ExecutionPlanRecord>(b?.executionPlan, {} as ExecutionPlanRecord);
  if (!rec.strategy) return;
  rec.verificationStatus = { attempt, ...status };
  await prisma.build.update({ where: { id: buildId }, data: { executionPlan: JSON.stringify(rec) } });
}

/** Objective text for the engineer's first turn, shaped by the chosen strategy (not one fixed instruction for every task). */
export function strategyObjective(s: StrategyDecision["strategy"], base: string) {
  switch (s) {
    case "test_driven_repair":
      return `First reproduce the defect: write or extend a test that FAILS on the current code and run it (cmd_run) to show the failure. Then fix the root cause in the code under test (never weaken the test), and run the full suite.\n\n${base}`;
    case "investigate_then_execute":
      return `Before editing anything, investigate: read the relevant files, contracts, tests and how the code is wired (fs_read/fs_list); write down what you found and which files must change. Then implement.\n\n${base}`;
    case "plan_then_execute":
    case "collaborative":
      return `Start by writing a short implementation plan (steps, and the files each step touches). Then execute it step by step, running the tests after each step.\n\n${base}`;
    case "sequential_handoff":
      return `This task builds on upstream work: read the approved contract/handoff sections in the context first and implement exactly to them; if they conflict with the code, say so instead of diverging.\n\n${base}`;
    case "high_assurance":
      return `High-assurance change: investigate first (read every file you will touch and its tests), keep the change minimal, add tests for every acceptance criterion INCLUDING negative/authorization cases, and run the full suite. Reviewers must explicitly approve.\n\n${base}`;
    default:
      return base;
  }
}
