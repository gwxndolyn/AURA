/**
 * Mission planner. Converts an objective into a validated, versioned plan.
 *
 * Plans are composed from task REQUIREMENTS (kind, domain, tools, write scope),
 * and agents are assigned by deterministic capability matching
 * (capabilities.ts → assignAgent). The workflow depends on risk:
 *   LOW    → requirements, architecture, fix, QA, review, report
 *   MEDIUM → + security review
 *   HIGH   → + security review + human release gate
 * Every code change gets an independent QA test and an independent reviewer
 * (never the implementer).
 *
 * Templates are only offered when a fixture repository backs them; any other
 * objective gets an analysis-only plan — AURA does not pretend to change code
 * it cannot execute.
 */
import { z } from "zod";
import { isAllowed } from "@/lib/agents/permissions";
import { getAgentDef } from "@/lib/agents/definitions";
import { assignAgent, capabilityFor, AssignmentError, type TaskRequirement } from "@/lib/agents/capabilities";
import { findCycle } from "./graph";
import { repoFor } from "./repos";

export const TASK_KINDS = ["REQUIREMENTS", "ARCHITECTURE", "ANALYSIS", "REPRODUCE", "CODE_CHANGE", "TEST", "REVIEW", "SECURITY_REVIEW", "APPROVAL", "REPORT"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type Risk = (typeof RISK_LEVELS)[number];

export const PLAN_SCHEMA_VERSION = 2;

export const PlanTaskSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  title: z.string().min(3).max(120),
  description: z.string().min(3).max(800),
  kind: z.enum(TASK_KINDS),
  agentKey: z.string(),
  assignmentReason: z.string().max(400).default(""),
  domain: z.string().max(40).default(""),
  files: z.array(z.string()).max(10).default([]),
  tools: z.array(z.string()).max(6),
  dependsOn: z.array(z.string()).max(8),
  acceptance: z.array(z.string().min(3)).max(8),
  required: z.boolean(),
  maxAttempts: z.number().int().min(1).max(3),
  budgetUsd: z.number().min(0).max(5).default(0.25),
});

export const PlanSchema = z.object({
  summary: z.string().min(10).max(1000),
  risks: z.array(z.string()).max(10),
  acceptance: z.array(z.string().min(3)).min(1).max(10),
  estimatedMinutes: z.number().int().min(1).max(600),
  risk: z.enum(RISK_LEVELS).default("LOW"),
  maxRepairs: z.number().int().min(0).max(5).default(2),
  tasks: z.array(PlanTaskSchema).min(1).max(20),
});
export type PlanTask = z.infer<typeof PlanTaskSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export interface PlanValidation {
  ok: boolean;
  errors: string[];
}

/** Tasks that may run concurrently (no dependency path between them). */
function concurrent(tasks: PlanTask[], a: string, b: string): boolean {
  const by = new Map(tasks.map((t) => [t.key, t]));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    for (const d of by.get(from)?.dependsOn ?? []) {
      if (d === to) return true;
      if (!seen.has(d)) {
        seen.add(d);
        if (reaches(d, to, seen)) return true;
      }
    }
    return false;
  };
  return !reaches(a, b) && !reaches(b, a);
}

/**
 * Structural + policy validation. A plan is rejected (not repaired) when it:
 * references unknown agents; assigns a kind the agent cannot own; requests
 * tools outside the allowlist; has cycles; omits independent verification for
 * a code change; lets an implementer review its own work; or lets two
 * concurrently-runnable tasks write the same file.
 */
export function validatePlan(plan: Plan): PlanValidation {
  const errors: string[] = [];
  const parsed = PlanSchema.safeParse(plan);
  if (!parsed.success) return { ok: false, errors: parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`) };
  const keys = new Set<string>();
  for (const t of plan.tasks) {
    if (keys.has(t.key)) errors.push(`duplicate task key ${t.key}`);
    keys.add(t.key);
    if (!getAgentDef(t.agentKey)) errors.push(`${t.key}: unknown agent ${t.agentKey}`);
    const cap = capabilityFor(t.agentKey);
    if (!cap) errors.push(`${t.key}: agent ${t.agentKey} has no capability profile`);
    else if (!cap.taskKinds.includes(t.kind)) errors.push(`${t.key}: agent ${t.agentKey} cannot perform ${t.kind}`);
    for (const tool of t.tools) if (!isAllowed(t.agentKey, tool)) errors.push(`${t.key}: agent ${t.agentKey} is not permitted to use ${tool}`);
    if (t.files.length && !cap?.canWriteCode) errors.push(`${t.key}: ${t.agentKey} has a write scope but cannot write code`);
  }
  const cycle = findCycle(plan.tasks.map((t) => ({ key: t.key, dependsOn: t.dependsOn, status: "PENDING" })));
  if (cycle) errors.push(`dependency cycle: ${cycle.join(" → ")}`);
  if (cycle) return { ok: false, errors };

  const codeTasks = plan.tasks.filter((t) => t.kind === "CODE_CHANGE");
  for (const c of codeTasks) {
    const tests = plan.tasks.filter((t) => t.kind === "TEST" && t.dependsOn.includes(c.key));
    if (!tests.length) errors.push(`${c.key}: code change has no TEST task depending on it`);
    const reviews = plan.tasks.filter((t) => t.kind === "REVIEW" && (t.dependsOn.includes(c.key) || tests.some((x) => t.dependsOn.includes(x.key))));
    if (!reviews.length) errors.push(`${c.key}: code change has no independent REVIEW`);
    for (const r of reviews) if (r.agentKey === c.agentKey) errors.push(`${r.key}: ${r.agentKey} cannot review its own change ${c.key}`);
    if (!c.files.length) errors.push(`${c.key}: code change has no write scope`);
  }
  // Two writers of the same file must be ordered by a dependency path.
  for (let i = 0; i < codeTasks.length; i++)
    for (let j = i + 1; j < codeTasks.length; j++) {
      const shared = codeTasks[i].files.filter((f) => codeTasks[j].files.includes(f));
      if (shared.length && concurrent(plan.tasks, codeTasks[i].key, codeTasks[j].key))
        errors.push(`${codeTasks[i].key} and ${codeTasks[j].key} may run concurrently and both write ${shared.join(", ")}`);
    }
  if (plan.risk === "HIGH" && !plan.tasks.some((t) => t.kind === "APPROVAL")) errors.push("HIGH-risk plan has no human approval gate");
  return { ok: errors.length === 0, errors };
}

interface TaskDraft extends Omit<TaskRequirement, "key"> {
  key: string;
  title: string;
  description: string;
  dependsOn: string[];
  acceptance: string[];
  files?: string[];
  required?: boolean;
  maxAttempts?: number;
}

/**
 * Assign agents to drafted tasks by capability. Reviewers are made independent
 * of every implementer whose change they review.
 */
export function delegate(drafts: TaskDraft[]): PlanTask[] {
  const assigned = new Map<string, string>();
  const out: PlanTask[] = [];
  for (const d of drafts) {
    const exclude = d.kind === "REVIEW" ? drafts.filter((x) => x.kind === "CODE_CHANGE").map((x) => assigned.get(x.key)!).filter(Boolean) : d.excludeAgents;
    const a = assignAgent({ key: d.key, kind: d.kind, domain: d.domain, tools: d.tools, writes: d.writes, excludeAgents: exclude });
    assigned.set(d.key, a.agentKey);
    const cap = capabilityFor(a.agentKey)!;
    out.push({
      key: d.key,
      title: d.title,
      description: d.description,
      kind: d.kind as TaskKind,
      agentKey: a.agentKey,
      assignmentReason: a.reason,
      domain: d.domain ?? "",
      files: d.files ?? [],
      tools: d.tools,
      dependsOn: d.dependsOn,
      acceptance: d.acceptance,
      required: d.required ?? true,
      maxAttempts: d.maxAttempts ?? cap.retry.maxAttempts,
      budgetUsd: cap.maxCostUsdPerTask,
    });
  }
  return out;
}

/** Engineering plan for a fixture repo, composed by risk level. */
export function engineeringPlan(template: string, opts: { risk?: Risk; maxRepairs?: number } = {}): Plan {
  const repo = repoFor(template);
  if (!repo) throw new Error(`No fixture repository for template ${template}`);
  const risk: Risk = opts.risk ?? (template === "checkout-fix" ? "HIGH" : "LOW");
  const scope = repo.writeScope;
  const src = repo.sourceFiles.join(", ");
  const drafts: TaskDraft[] = [
    {
      key: "requirements",
      kind: "REQUIREMENTS",
      domain: "product",
      tools: [],
      writes: false,
      title: "Clarify requirements",
      description: `Turn the objective and ${repo.ticket.split(":")[0]} into requirements, measurable acceptance criteria, open questions and constraints.`,
      dependsOn: [],
      acceptance: ["At least one measurable acceptance criterion", "Open questions listed explicitly"],
    },
    {
      key: "architecture",
      kind: "ARCHITECTURE",
      domain: "backend",
      tools: ["code.read"],
      writes: false,
      title: "Locate the defect and propose a boundary",
      description: `Read ${src} and its tests, identify the defect, name the affected files and the smallest safe change.`,
      dependsOn: ["requirements"],
      acceptance: ["Affected files named", "Risks and interface impact stated"],
    },
    {
      key: "reproduce",
      kind: "REPRODUCE",
      domain: "backend",
      tools: ["test.run"],
      writes: false,
      title: "Reproduce with the existing tests",
      description: "Run the test suite on the current code in the sandbox and record which tests fail.",
      dependsOn: ["requirements"],
      acceptance: ["The reported defect is reproduced by at least one failing test"],
    },
    {
      key: "fix",
      kind: "CODE_CHANGE",
      domain: "backend",
      tools: ["code.read", "code.write"],
      writes: true,
      files: scope,
      title: "Implement the minimal fix",
      description: `Change only ${scope.join(", ")} to fix the defect. Address every open blocking finding by id.`,
      dependsOn: ["architecture", "reproduce"],
      acceptance: ["Diff confined to the write scope", "Each repair references the finding it addresses"],
    },
    {
      key: "verify",
      kind: "TEST",
      domain: "backend",
      tools: ["test.run"],
      writes: false,
      title: "Run the relevant tests",
      description: "Re-run the full suite in the sandbox on the changed code. Results decide; the implementer's description does not.",
      dependsOn: ["fix"],
      acceptance: ["All tests pass in the Docker sandbox"],
    },
    {
      key: "review",
      kind: "REVIEW",
      domain: "backend",
      tools: ["code.read", "sandbox.exec"],
      writes: false,
      title: "Independent code review",
      description: "Review the change against the objective. Every concern must be backed by an executed probe; unsupported concerns are recorded but never block.",
      dependsOn: ["verify"],
      acceptance: ["No blocking finding remains open", "Every finding cites executed evidence"],
    },
  ];
  if (risk !== "LOW") {
    drafts.push({
      key: "security-review",
      kind: "SECURITY_REVIEW",
      domain: "security",
      tools: ["security.scan"],
      writes: false,
      title: "Security review of the change",
      description: "Deterministic checks of validation and trust boundaries on the final code.",
      dependsOn: ["review"],
      acceptance: ["No security check fails on the final code"],
    });
  }
  if (risk === "HIGH") {
    drafts.push({
      key: "approve-release",
      kind: "APPROVAL",
      domain: "ops",
      tools: [],
      writes: false,
      title: "Approve change for release",
      description: "A human reviews the diff, test evidence and findings, then approves or rejects marking the change ready to release.",
      dependsOn: ["review", "security-review"],
      acceptance: ["A human approved the exact diff that was tested and reviewed"],
      maxAttempts: 1,
    });
  }
  drafts.push({
    key: "report",
    kind: "REPORT",
    domain: "product",
    tools: [],
    writes: false,
    title: "Write the mission report",
    description: "Explain the cause, the change, the verified results, the review outcome and anything unresolved.",
    dependsOn: [risk === "HIGH" ? "approve-release" : risk === "MEDIUM" ? "security-review" : "review"],
    acceptance: ["Report cites recorded evidence"],
  });

  const acceptance = template === "checkout-fix"
    ? [
        "All checkout tests pass in the sandbox, including the regression test for the $0.29 undercharge.",
        "Negative quantities are rejected by checkout.",
        "An independent review finds no blocking issue backed by evidence.",
        "A security review of the diff finds no payment-safety issue.",
        "A human approves the change before it is marked ready to release.",
      ]
    : [
        `The failing ${template === "checkout-validation" ? "validation " : ""}test passes in the sandbox, with no other test regressing.`,
        "The change stays inside the declared write scope.",
        "An independent review finds no blocking issue backed by evidence.",
        ...(risk !== "LOW" ? ["A security review of the change passes."] : []),
        ...(risk === "HIGH" ? ["A human approves the change before it is marked ready to release."] : []),
      ];

  return {
    summary: `Fix "${repo.title}": clarify requirements, locate the defect, reproduce it with the existing tests, make a scoped change, verify it in the sandbox, and have it independently reviewed${risk !== "LOW" ? " and security-checked" : ""}${risk === "HIGH" ? ", then stop for human approval" : ""}. Up to ${opts.maxRepairs ?? 2} repair rounds.`,
    risks: [
      "Simulation mode (no API key): the engineer's edits are prepared repair candidates, labelled as such; tests and probes still run for real in Docker.",
      "No real deployment happens in AURA.",
      ...(risk === "HIGH" ? ["Payment amounts are customer-facing; an incorrect fix could over- or under-charge."] : []),
    ],
    acceptance,
    estimatedMinutes: 4,
    risk,
    maxRepairs: opts.maxRepairs ?? 2,
    tasks: delegate(drafts),
  };
}

/** Backwards-compatible name for the showcase plan. */
export function checkoutFixPlan(): Plan {
  return engineeringPlan("checkout-fix");
}

/** Pick a template for an objective. Only templates with real execution backing are offered. */
export function templateFor(objective: string): "checkout-fix" | "checkout-validation" | null {
  if (/checkout|cart/i.test(objective) && /validat/i.test(objective)) return "checkout-validation";
  return /checkout|charg|cents?|rounding|payment amount/i.test(objective) ? "checkout-fix" : null;
}

/**
 * Generic (non-template) plan: analysis + report only. AURA does not have a
 * codebase/test harness for arbitrary objectives, so it does not pretend to.
 */
export function genericPlan(objective: string, pmSummary: string): Plan {
  return {
    summary: pmSummary.slice(0, 900) || `Analyze: ${objective}`,
    risks: ["No executable codebase is attached to this objective; AURA can analyze and plan but cannot verify code changes for it."],
    acceptance: ["An analysis with recommended next steps is produced and reviewed."],
    estimatedMinutes: 2,
    risk: "LOW",
    maxRepairs: 0,
    tasks: delegate([
      { key: "analyze", kind: "ANALYSIS", domain: "backend", tools: ["code.read"], writes: false, title: "Analyze the objective", description: objective.slice(0, 700), dependsOn: [], acceptance: ["Analysis recorded"] },
      { key: "report", kind: "REPORT", domain: "product", tools: [], writes: false, title: "Write the mission report", description: "Summarize findings and the work that would be needed to execute them.", dependsOn: ["analyze"], acceptance: ["Report produced"] },
    ]),
  };
}

export { AssignmentError };
