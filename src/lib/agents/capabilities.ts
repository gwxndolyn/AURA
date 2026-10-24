/**
 * Typed agent capability registry.
 *
 * `definitions.ts` holds identity + prompt; this file holds what an agent can
 * actually DO, and is what the planner, scheduler and tool runner enforce:
 *   - task kinds it can own, and the domains it may change
 *   - which tools it uses (must be a subset of its role allowlist — tested)
 *   - required context sources for each kind
 *   - output contract (per task kind, see contracts.ts)
 *   - model routing preference, budgets, timeouts, retry policy
 *   - verification the engine applies to its work, and which actions need a human
 *
 * Nothing here relies on the prompt: every field is checked in code.
 */
import { z } from "zod";
import type { ModelTier } from "@/lib/types";
import { permissionsFor, type ToolName } from "./permissions";
import { OUTPUT_SCHEMAS, type OutputKind } from "./contracts";
import { AGENT_DEFS } from "./definitions";

export const CONTEXT_KINDS = [
  "objective", // mission objective
  "acceptance", // mission acceptance criteria
  "plan", // current plan summary + version
  "task", // the task itself (description, acceptance, write scope)
  "handoffs", // validated handoffs from dependencies
  "conventions", // repository/project conventions relevant to the domain
  "code", // relevant source files (write scope + read scope)
  "tests", // relevant test files
  "test-results", // latest persisted test evidence
  "findings", // open findings addressed by this task
  "security", // security constraints / trust boundaries
  "attempts", // previous attempts of this task
] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

export const VERIFICATIONS = [
  "schema", // output validated against the kind contract
  "sandbox-tests", // tests executed in Docker; recorded results decide
  "probe-evidence", // findings must be reproduced by an executed probe
  "deterministic-checks", // code-level checks computed by the engine
  "human-approval", // a person decides
] as const;

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(3),
  /** Which failure categories may be retried automatically (never auth/policy/budget). */
  retryOn: z.array(z.enum(["tool_timeout", "tool_execution_error", "invalid_structured_output", "provider_error"])),
});

export const CapabilitySchema = z.object({
  agentKey: z.string(),
  description: z.string().min(10),
  taskKinds: z.array(z.string()).min(1),
  domains: z.array(z.string()),
  tools: z.array(z.string()),
  requiredContext: z.record(z.array(z.enum(CONTEXT_KINDS))),
  tier: z.enum(["FAST", "STANDARD", "REASONING"]),
  maxDurationMs: z.number().int().min(1000).max(600_000),
  maxCostUsdPerTask: z.number().min(0.001).max(5),
  maxContextTokens: z.number().int().min(500).max(150_000),
  retry: RetryPolicySchema,
  verification: z.array(z.enum(VERIFICATIONS)),
  approvalRequiredFor: z.array(z.string()),
  canWriteCode: z.boolean(),
});
export type AgentCapability = z.infer<typeof CapabilitySchema> & { tier: ModelTier; tools: ToolName[] };

const RETRY_TRANSIENT = { maxAttempts: 2, retryOn: ["tool_timeout", "tool_execution_error", "invalid_structured_output", "provider_error"] as const };
const NO_RETRY = { maxAttempts: 1, retryOn: [] as const };

const CAPS: AgentCapability[] = [
  {
    agentKey: "product-manager",
    description: "Turns objectives into requirements, measurable acceptance criteria, open questions and constraints; writes the final mission report.",
    taskKinds: ["REQUIREMENTS", "ANALYSIS", "REPORT"],
    domains: ["product"],
    tools: ["planning.createTask", "message.send"],
    requiredContext: { REQUIREMENTS: ["objective", "task"], ANALYSIS: ["objective", "task"], REPORT: ["objective", "acceptance", "handoffs", "findings", "test-results"] },
    tier: "STANDARD",
    maxDurationMs: 60_000,
    maxCostUsdPerTask: 0.1,
    maxContextTokens: 8000,
    retry: { ...RETRY_TRANSIENT, retryOn: [...RETRY_TRANSIENT.retryOn] },
    verification: ["schema"],
    approvalRequiredFor: [],
    canWriteCode: false,
  },
  {
    agentKey: "architect",
    description: "Reads the codebase to locate the defect, names affected modules and interfaces, and states risks and implementation boundaries.",
    taskKinds: ["ARCHITECTURE", "ANALYSIS"],
    domains: ["backend", "frontend", "data"],
    tools: ["code.read", "message.send"],
    requiredContext: { ARCHITECTURE: ["objective", "task", "handoffs", "code", "tests", "test-results", "conventions"], ANALYSIS: ["objective", "task", "code"] },
    tier: "REASONING",
    maxDurationMs: 90_000,
    maxCostUsdPerTask: 0.2,
    maxContextTokens: 16000,
    retry: { ...RETRY_TRANSIENT, retryOn: [...RETRY_TRANSIENT.retryOn] },
    verification: ["schema"],
    approvalRequiredFor: [],
    canWriteCode: false,
  },
  {
    agentKey: "frontend-engineer",
    description: "Implements UI changes inside its assigned file scope, following the design system; produces diffs.",
    taskKinds: ["CODE_CHANGE"],
    domains: ["frontend"],
    tools: ["code.read", "code.write", "sandbox.exec", "message.send"],
    requiredContext: { CODE_CHANGE: ["task", "handoffs", "code", "conventions", "findings", "attempts"] },
    tier: "STANDARD",
    maxDurationMs: 120_000,
    maxCostUsdPerTask: 0.25,
    maxContextTokens: 20000,
    retry: { ...RETRY_TRANSIENT, retryOn: [...RETRY_TRANSIENT.retryOn] },
    verification: ["schema", "sandbox-tests"],
    approvalRequiredFor: [],
    canWriteCode: true,
  },
  {
    agentKey: "backend-engineer",
    description: "Implements service/API changes inside its assigned file scope with validation and error handling; produces diffs addressing open findings.",
    taskKinds: ["CODE_CHANGE"],
    domains: ["backend"],
    tools: ["code.read", "code.write", "sandbox.exec", "message.send"],
    requiredContext: { CODE_CHANGE: ["task", "handoffs", "code", "tests", "test-results", "conventions", "findings", "attempts", "security"] },
    tier: "STANDARD",
    maxDurationMs: 120_000,
    maxCostUsdPerTask: 0.25,
    maxContextTokens: 20000,
    retry: { ...RETRY_TRANSIENT, retryOn: [...RETRY_TRANSIENT.retryOn] },
    verification: ["schema", "sandbox-tests"],
    approvalRequiredFor: [],
    canWriteCode: true,
  },
  {
    agentKey: "qa-engineer",
    description: "Runs the relevant test suites in the sandbox and reports actual results; never accepts an implementer's description as evidence.",
    taskKinds: ["REPRODUCE", "TEST"],
    domains: ["backend", "frontend"],
    tools: ["code.read", "test.run", "sandbox.exec", "message.send"],
    requiredContext: { REPRODUCE: ["objective", "task", "tests", "handoffs"], TEST: ["acceptance", "task", "tests", "handoffs"] },
    tier: "FAST",
    maxDurationMs: 60_000,
    maxCostUsdPerTask: 0.05,
    maxContextTokens: 8000,
    retry: { ...RETRY_TRANSIENT, retryOn: ["tool_timeout", "tool_execution_error", "provider_error"] },
    verification: ["schema", "sandbox-tests"],
    approvalRequiredFor: [],
    canWriteCode: false,
  },
  {
    agentKey: "reviewer",
    description: "Reviews a change against the objective using executed probes; raises findings only with reproducible evidence.",
    taskKinds: ["REVIEW"],
    domains: ["backend", "frontend"],
    tools: ["code.read", "sandbox.exec", "message.send"],
    requiredContext: { REVIEW: ["objective", "acceptance", "task", "handoffs", "code", "test-results", "findings"] },
    tier: "REASONING",
    maxDurationMs: 90_000,
    maxCostUsdPerTask: 0.2,
    maxContextTokens: 20000,
    retry: { ...RETRY_TRANSIENT, retryOn: [...RETRY_TRANSIENT.retryOn] },
    verification: ["schema", "probe-evidence"],
    approvalRequiredFor: [],
    canWriteCode: false,
  },
  {
    agentKey: "security-engineer",
    description: "Reviews validation, trust boundaries and data handling in the changed files with deterministic checks.",
    taskKinds: ["SECURITY_REVIEW"],
    domains: ["backend", "frontend", "security"],
    tools: ["security.scan", "logs.read", "message.send"],
    requiredContext: { SECURITY_REVIEW: ["task", "handoffs", "code", "security"] },
    tier: "REASONING",
    maxDurationMs: 60_000,
    maxCostUsdPerTask: 0.15,
    maxContextTokens: 16000,
    retry: { ...NO_RETRY, retryOn: [] },
    verification: ["schema", "deterministic-checks"],
    approvalRequiredFor: ["security.patch"],
    canWriteCode: false,
  },
  {
    agentKey: "devops",
    description: "Owns release readiness: requests the human release gate; deploy actions always require approval.",
    taskKinds: ["APPROVAL"],
    domains: ["ops"],
    tools: ["logs.read", "message.send"],
    requiredContext: { APPROVAL: ["task", "handoffs", "test-results", "findings"] },
    tier: "STANDARD",
    maxDurationMs: 30_000,
    maxCostUsdPerTask: 0.02,
    maxContextTokens: 4000,
    retry: { ...NO_RETRY, retryOn: [] },
    verification: ["human-approval"],
    approvalRequiredFor: ["deploy.run", "deploy.rollback"],
    canWriteCode: false,
  },
];

export const CAPABILITIES: Record<string, AgentCapability> = Object.fromEntries(CAPS.map((c) => [c.agentKey, c]));

export function capabilityFor(agentKey: string): AgentCapability | undefined {
  return CAPABILITIES[agentKey];
}

/**
 * Registry self-check, run in tests and at plan time:
 *  - every agent exists in definitions.ts
 *  - capability tools ⊆ role allowlist (registry can't widen permissions)
 *  - only code-writing agents hold code.write
 *  - every task kind has an output contract and required-context entry
 */
export function validateRegistry(): string[] {
  const errors: string[] = [];
  const known = new Set(AGENT_DEFS.map((d) => d.key));
  for (const c of CAPS) {
    const parsed = CapabilitySchema.safeParse(c);
    if (!parsed.success) errors.push(`${c.agentKey}: ${parsed.error.errors.map((e) => e.message).join(", ")}`);
    if (!known.has(c.agentKey)) errors.push(`${c.agentKey}: not in agent definitions`);
    const allow = permissionsFor(c.agentKey);
    for (const t of c.tools) if (!allow.includes(t)) errors.push(`${c.agentKey}: capability tool ${t} is outside its role allowlist`);
    if (c.tools.includes("code.write") !== c.canWriteCode) errors.push(`${c.agentKey}: canWriteCode disagrees with tools`);
    for (const k of c.taskKinds) {
      if (!(k in OUTPUT_SCHEMAS)) errors.push(`${c.agentKey}: no output contract for ${k}`);
      if (!c.requiredContext[k]) errors.push(`${c.agentKey}: no required-context entry for ${k}`);
    }
  }
  return errors;
}

export interface TaskRequirement {
  key: string;
  kind: string;
  domain?: string;
  tools: string[];
  writes: boolean;
  /** Agents that must not own this task (e.g. the implementer may not review its own work). */
  excludeAgents?: string[];
}

export interface Assignment {
  agentKey: string;
  reason: string;
}

export class AssignmentError extends Error {
  constructor(public taskKey: string, public reasons: string[]) {
    super(`No capable agent for task "${taskKey}": ${reasons.join("; ")}`);
    this.name = "AssignmentError";
  }
}

/**
 * Deterministic capability-based delegation. Filters agents that can own the
 * task kind, cover the domain, hold every required tool, and may write when
 * writing is needed; then prefers the cheapest tier, then the narrowest
 * specialist (fewest task kinds). Throws with per-agent reasons when none fit.
 */
export function assignAgent(req: TaskRequirement): Assignment {
  const rejected: string[] = [];
  const fits: AgentCapability[] = [];
  for (const c of CAPS) {
    const why: string[] = [];
    if (!c.taskKinds.includes(req.kind)) why.push(`does not handle ${req.kind}`);
    if (req.domain && c.domains.length && !c.domains.includes(req.domain)) why.push(`no ${req.domain} domain`);
    const missing = req.tools.filter((t) => !c.tools.includes(t as ToolName));
    if (missing.length) why.push(`lacks ${missing.join(", ")}`);
    if (req.writes && !c.canWriteCode) why.push("cannot write code");
    if (req.excludeAgents?.includes(c.agentKey)) why.push("excluded (independence)");
    if (why.length) rejected.push(`${c.agentKey}: ${why.join(", ")}`);
    else fits.push(c);
  }
  if (!fits.length) {
    // Only report agents that handle the kind; if none do, say so plainly.
    const relevant = rejected.filter((r) => !r.includes("does not handle"));
    throw new AssignmentError(req.key, relevant.length ? relevant : [`no agent handles ${req.kind}`]);
  }
  const rank: Record<ModelTier, number> = { FAST: 0, STANDARD: 1, REASONING: 2 };
  fits.sort((a, b) => rank[a.tier] - rank[b.tier] || a.taskKinds.length - b.taskKinds.length || a.agentKey.localeCompare(b.agentKey));
  const c = fits[0];
  return {
    agentKey: c.agentKey,
    reason: `${c.agentKey} handles ${req.kind}${req.domain ? ` in ${req.domain}` : ""} with ${req.tools.length ? req.tools.join(", ") : "no tools"}${fits.length > 1 ? ` (chosen over ${fits.slice(1).map((f) => f.agentKey).join(", ")}: ${c.tier} tier, narrower scope)` : ""}`,
  };
}

export type { OutputKind };
