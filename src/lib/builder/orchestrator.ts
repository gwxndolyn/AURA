/**
 * Chief Orchestrator policy for one engineering run (pure, deterministic,
 * unit-tested). The engine (engine.ts) executes; this module decides:
 *
 *   assessRisk         how much verification a task needs (risk-based gates)
 *   reviewPlan         which independent reviewers must participate
 *   handoffFor         the task's input contract: the approved design handoff
 *                      and architecture contracts addressed to THIS task
 *                      (not "the latest blob"), with their acceptance lines
 *                      merged into what QA must verify
 *   missingInputs      mandatory upstream artifacts that do not exist yet
 *                      (downstream work does not start without them)
 *   recoveryFor        a strategy per failure category — not "try again"
 *   resolveDisagreement  bounded, evidence-first decision when reviewers disagree
 *   contextPackage     the task-specific context with provenance per section
 *
 * Progress is measured by verified work products: nothing here marks work
 * done; the engine's executed checks and the gate do.
 */
import type { DefectView } from "./debug";

export type Risk = "LOW" | "MEDIUM" | "HIGH";

const SENSITIVE: [RegExp, string][] = [
  [/\b(auth|login|logout|session|password|token|jwt|oauth|sign[- ]?in|permission|role|admin|rbac|access control)\b/i, "authentication/authorization"],
  [/\b(payment|billing|checkout|stripe|invoice|subscription|refund)\b/i, "payments"],
  [/\b(migration|schema|alter table|drop|delete all|backfill)\b/i, "data migration"],
  [/\b(pii|personal data|gdpr|encrypt|secret|credential|api key)\b/i, "sensitive data"],
  [/\b(concurren|race|lock|transaction|idempoten)\w*/i, "concurrency"],
  [/\b(deploy|production|infrastructure|docker|ci\b)/i, "deployment"],
];

/** Effective risk = max(planned risk, what the task text and files touch). Never lowers the planner's risk. */
export function assessRisk(t: { risk: string; title: string; description: string; acceptance: string[]; files: string[] }): { risk: Risk; reasons: string[] } {
  const text = `${t.title}\n${t.description}\n${t.acceptance.join("\n")}\n${t.files.join(" ")}`;
  const reasons = SENSITIVE.filter(([re]) => re.test(text)).map(([, why]) => why);
  const planned = (["LOW", "MEDIUM", "HIGH"].includes(t.risk) ? t.risk : "MEDIUM") as Risk;
  const raised: Risk = reasons.length ? "HIGH" : planned;
  return { risk: rank(raised) > rank(planned) ? raised : planned, reasons };
}
const rank = (r: Risk) => ({ LOW: 0, MEDIUM: 1, HIGH: 2 })[r];

export interface ReviewPlan { reviewers: ("qa-engineer" | "security-engineer" | "reviewer")[]; requireApproveVerdict: boolean; why: string }

/**
 * Proportionate review: every change gets QA (criteria must be proven) and the
 * code reviewer. Security review joins for MEDIUM/HIGH risk or any sensitive
 * surface. HIGH risk additionally requires an explicit "approve" verdict from
 * every reviewer — silence or unparseable output is not approval.
 */
export function reviewPlan(risk: Risk, reasons: string[]): ReviewPlan {
  const security = risk !== "LOW" || reasons.length > 0;
  return {
    reviewers: ["qa-engineer", ...(security ? (["security-engineer"] as const) : []), "reviewer"],
    requireApproveVerdict: risk === "HIGH",
    why: risk === "HIGH" ? `high risk${reasons.length ? ` (${reasons.join(", ")})` : ""}: independent security review + explicit approval from every reviewer` : risk === "MEDIUM" ? "medium risk: QA, security and code review" : "low risk: QA and code review",
  };
}

export interface HandoffArtifact { id: string; kind: string; version: number; content: string; consumedBy: string }

/** The approved upstream artifacts addressed to this task (or product-wide when they name no consumers). */
export function handoffFor(itemKey: string, parentKey: string | null, artifacts: HandoffArtifact[]) {
  const parse = <T,>(s: string, f: T): T => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return f;
    }
  };
  const keys = [itemKey, parentKey].filter(Boolean) as string[];
  const addressed = (a: HandoffArtifact) => {
    const consumers = parse<string[]>(a.consumedBy, []);
    return consumers.length === 0 || consumers.some((c) => keys.includes(c));
  };
  const latest = (kind: string) => artifacts.filter((a) => a.kind === kind && addressed(a)).sort((a, b) => b.version - a.version)[0] ?? null;
  const design = latest("HANDOFF");
  const arch = latest("ARCHITECTURE");
  const d = design ? parse<{ acceptance?: string[]; designVersion?: number; pages?: unknown[]; components?: unknown[]; tokens?: unknown; accessibility?: string[] }>(design.content, {}) : null;
  const a = arch ? parse<{ contracts?: { name: string; signature: string; rules: string[] }[]; decisions?: { id: string; decision: string }[]; dataModel?: unknown[] }>(arch.content, {}) : null;
  const designAcceptance = (d?.acceptance ?? []).slice(0, 8).map((x) => `Design: ${x}`);
  const contractAcceptance = (a?.contracts ?? []).slice(0, 6).flatMap((c) => (c.rules ?? []).slice(0, 2).map((r) => `Contract ${c.name}: ${r}`)).slice(0, 8);
  return {
    design: design ? { ref: `${design.kind} ${design.id.slice(-6)} v${design.version}`, text: JSON.stringify({ designVersion: d?.designVersion, pages: d?.pages, components: d?.components, tokens: d?.tokens, accessibility: d?.accessibility }).slice(0, 5000) } : null,
    architecture: arch ? { ref: `ARCHITECTURE ${arch.id.slice(-6)} v${arch.version}`, text: JSON.stringify({ contracts: a?.contracts, decisions: a?.decisions, dataModel: a?.dataModel }).slice(0, 5000) } : null,
    /** Acceptance lines QA must also verify (handoff + contracts). */
    extraAcceptance: [...designAcceptance, ...contractAcceptance],
  };
}

/**
 * Mandatory inputs: a FRONTEND task in a product that has a DESIGN task needs
 * the approved design handoff; a task that depends on an ARCHITECTURE task
 * needs the approved architecture. Returns what is missing (empty = may start).
 */
export function missingInputs(item: { kind: string; dependsOn: string[] }, product: { designTaskKeys: string[]; archTaskKeys: string[]; hasApprovedHandoff: boolean; hasApprovedArchitecture: boolean }) {
  const missing: string[] = [];
  const dependsOnDesign = item.dependsOn.some((d) => product.designTaskKeys.includes(d));
  if ((item.kind === "FRONTEND" || dependsOnDesign) && product.designTaskKeys.length && !product.hasApprovedHandoff) missing.push("approved design handoff");
  if (item.dependsOn.some((d) => product.archTaskKeys.includes(d)) && !product.hasApprovedArchitecture) missing.push("approved architecture contracts");
  return missing;
}

export type Recovery =
  | { action: "repair"; strategy: string; brief: string; tier: "same" | "escalate" }
  | { action: "retry_later"; strategy: string; brief: string };

/**
 * Category-specific recovery. The same instruction is never simply repeated:
 * each category changes what the engineer is told to look at, or stops the
 * run when code changes cannot help (infrastructure, permissions, missing
 * configuration the agent may not change).
 */
export function recoveryFor(defects: Pick<DefectView, "category" | "occurrences" | "title" | "failingTests">[], attempt: number): Recovery {
  const cats = new Set(defects.map((d) => d.category));
  const recurring = defects.some((d) => d.occurrences >= 2);
  if (cats.has("infrastructure") || cats.has("permissions")) return { action: "retry_later", strategy: "environment", brief: "The sandbox environment failed (not a code defect). The run is re-queued; no code change is requested." };
  if (cats.has("timeout")) return { action: "repair", strategy: "hang", tier: recurring ? "escalate" : "same", brief: "Strategy (timeout): a test or the server does not finish. Look for servers not closed in tests (close them in finally), un-awaited promises, missing res.end(), infinite loops, or timers keeping the event loop alive. Do not raise timeouts to hide it." };
  if (cats.has("dependency")) return { action: "repair", strategy: "dependency", tier: "same", brief: "Strategy (dependency): a module or package is missing or unresolvable. Prefer Node built-ins and the project's existing helpers; if a package is truly needed, add it to package.json dependencies with an exact version (installs run with --ignore-scripts). Check import paths and file names." };
  if (cats.has("configuration")) return { action: "repair", strategy: "configuration", tier: "same", brief: "Strategy (configuration): the project setup is inconsistent (scripts, module format, paths, or no tests ran). Check package.json scripts, CommonJS vs ESM, and that test files match the runner's pattern (*.test.js). Fix configuration minimally." };
  if (cats.has("test_assumption")) return { action: "repair", strategy: "test_environment", tier: "same", brief: "Strategy (test environment): tests assume network, fixed ports or timing the sandbox does not provide. Start the server on port 0 (ephemeral), call it via 127.0.0.1, avoid external network and sleeps." };
  if (recurring && attempt >= 1) return { action: "repair", strategy: "rethink", tier: "escalate", brief: "Strategy (recurring defect): the same failure survived a repair. Re-read the failing test and the code it exercises from scratch; the previous fix addressed the wrong cause. Explain the root cause in your summary." };
  return { action: "repair", strategy: "code", tier: "same", brief: "Strategy (code defect): reproduce from the failing test output, find the root cause in the code under test, fix it there (not in the test), then run the full suite." };
}

export interface ReviewOutcome { source: "qa" | "security" | "review"; verdict: "approve" | "request_changes" | "missing"; blocking: { title: string; evidence: string }[] }

/**
 * Disagreement protocol (bounded, evidence-first). Executed evidence beats
 * opinion: a blocking finding with concrete evidence stands even if another
 * reviewer approved; a "request_changes" verdict without any evidenced
 * finding does not block (recorded as a disagreement for the summary). For
 * HIGH-risk work a missing verdict blocks (no implicit approval). The
 * decision owner is the orchestrator; reviewers get one round per attempt.
 */
export function resolveDisagreement(outcomes: ReviewOutcome[], opts: { requireApproveVerdict: boolean }) {
  const evidenced = outcomes.flatMap((o) => o.blocking.filter((b) => b.evidence.trim().length > 0).map((b) => ({ ...b, source: o.source })));
  const unsupported = outcomes.filter((o) => o.verdict === "request_changes" && !o.blocking.some((b) => b.evidence.trim()));
  const missing = outcomes.filter((o) => o.verdict === "missing");
  const approvals = outcomes.filter((o) => o.verdict === "approve").map((o) => o.source);
  const block = evidenced.length > 0 || (opts.requireApproveVerdict && missing.length > 0);
  const disagreement = approvals.length > 0 && (evidenced.length > 0 || unsupported.length > 0);
  const rationale = [
    evidenced.length ? `${evidenced.length} evidenced blocking finding(s) from ${[...new Set(evidenced.map((e) => e.source))].join(", ")}` : "",
    unsupported.length ? `request_changes without evidence from ${unsupported.map((u) => u.source).join(", ")} does not block` : "",
    opts.requireApproveVerdict && missing.length ? `high-risk change: no valid verdict from ${missing.map((m) => m.source).join(", ")}` : "",
    !block ? (approvals.length ? `approved by ${approvals.join(", ")}` : "no evidenced reviewer objection") : "",
  ].filter(Boolean).join("; ");
  return { block, disagreement, rationale };
}

export interface ContextSection { id: string; title: string; body: string; provenance: string }

/** Assemble the context package; returns the text and a provenance manifest (recorded on the run). */
export function contextPackage(sections: (ContextSection | null | false | undefined)[], budget = 60_000) {
  const kept: ContextSection[] = [];
  let used = 0;
  for (const s of sections) {
    if (!s || !s.body.trim()) continue;
    const body = s.body.length > budget - used ? s.body.slice(0, Math.max(0, budget - used)) : s.body;
    if (!body) break;
    used += body.length;
    kept.push({ ...s, body });
  }
  return {
    text: kept.map((s) => `# ${s.title}\n${s.body}`).join("\n\n"),
    manifest: kept.map((s) => ({ id: s.id, provenance: s.provenance, chars: s.body.length })),
  };
}
