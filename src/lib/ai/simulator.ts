import { hashString, seededRandom } from "@/lib/utils";

/**
 * Deterministic local reasoning engine. When no ANTHROPIC_API_KEY is set, agent
 * "thinking" is produced here. It is NOT random fluff: outputs are structured,
 * context-aware and seeded so the simulation is reproducible and believable.
 *
 * The `kind` hint tells us what shape of output the orchestrator expects. For
 * structured kinds we return JSON strings that the orchestrator parses.
 */

export interface SimParams {
  system: string;
  prompt: string;
  kind?: string;
  seed?: string;
}

function pick<T>(arr: T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)];
}

function take<T>(arr: T[], n: number, rnd: () => number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  while (out.length < n && copy.length) {
    out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]);
  }
  return out;
}

/** Extract the "# Objective" section from a built prompt, else the whole thing. */
function objectiveOf(prompt: string): string {
  const m = prompt.match(/#\s*Objective\s*\n([^\n]+)/i);
  return (m ? m[1] : prompt).replace(/^Plan:\s*/i, "").trim();
}

export function simulatedCompletion(params: SimParams): string {
  const seed = hashString((params.seed || "") + params.kind + params.prompt.slice(0, 64));
  const rnd = seededRandom(seed || 1);

  switch (params.kind) {
    case "plan":
      return JSON.stringify(simPlan(objectiveOf(params.prompt), rnd));
    case "architecture":
      return simArchitecture(params.prompt, rnd);
    case "code":
      return simCode(params.prompt, rnd);
    case "review":
      return simReview(rnd);
    case "test":
      return JSON.stringify(simTest(rnd));
    case "security-finding":
      return JSON.stringify(simAttack(params.prompt, rnd));
    case "attack":
      return JSON.stringify(simAttack(params.prompt, rnd));
    case "defense":
      return JSON.stringify(simDefense(params.prompt, rnd));
    case "decision":
      return JSON.stringify(simDecision(params.prompt, rnd));
    case "ceo":
      return simCeo(params.prompt, rnd);
    case "analysis":
      return simAnalysis(params.prompt, rnd);
    case "mission:REQUIREMENTS":
    case "mission:ARCHITECTURE":
    case "mission:ANALYSIS":
    case "mission:CODE_CHANGE":
    case "mission:REVIEW":
    case "mission:REPORT":
      return JSON.stringify(simMissionTask(params.kind.slice("mission:".length), params.prompt));
    case "summary":
    default:
      return simSummary(params.prompt, rnd);
  }
}

// ---- Planning: decompose a goal into tasks ----
interface SimTask {
  title: string;
  description: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  assignee: string; // agent key
  estimate: number;
  acceptance: string[];
}

export function simPlan(goal: string, rnd: () => number): { strategy: string; tasks: SimTask[] } {
  const g = goal.toLowerCase();
  const base: SimTask[] = [];

  const add = (t: SimTask) => base.push(t);

  if (g.includes("security") || g.includes("audit") || g.includes("vuln")) {
    add({
      title: "Threat-model the application surface",
      description: "Enumerate trust boundaries, entry points and sensitive data flows across services.",
      priority: "HIGH",
      assignee: "security-engineer",
      estimate: 5,
      acceptance: ["All services enumerated", "Trust boundaries documented", "Top risks ranked"],
    });
    add({
      title: "Run simulated red-team scan",
      description: "Probe the cyber range for weak auth, IDOR, injection and exposed endpoints.",
      priority: "HIGH",
      assignee: "red-team",
      estimate: 4,
      acceptance: ["Scan completed inside sandbox", "Findings recorded with evidence"],
    });
    add({
      title: "Patch highest-severity findings",
      description: "Remediate the top findings from the scan and add regression tests.",
      priority: "CRITICAL",
      assignee: "backend-engineer",
      estimate: 6,
      acceptance: ["Critical/high findings fixed", "Regression tests added", "Fixes verified"],
    });
  } else if (g.includes("cost") || g.includes("cloud")) {
    add({
      title: "Audit infrastructure spend",
      description: "Review simulated infra utilization and identify over-provisioned services.",
      priority: "MEDIUM",
      assignee: "devops",
      estimate: 4,
      acceptance: ["Utilization reviewed", "Savings opportunities listed"],
    });
    add({
      title: "Right-size services",
      description: "Scale down underutilized nodes and tune autoscaling thresholds.",
      priority: "MEDIUM",
      assignee: "devops",
      estimate: 3,
      acceptance: ["Nodes right-sized", "No regression in latency/error rate"],
    });
  } else {
    // Generic MVP / feature build pipeline.
    add({
      title: "Define product scope & acceptance criteria",
      description: `Translate the goal "${goal}" into a prioritized set of user stories.`,
      priority: "HIGH",
      assignee: "product-manager",
      estimate: 3,
      acceptance: ["Scope documented", "Acceptance criteria defined", "Priorities set"],
    });
    add({
      title: "Design system architecture",
      description: "Produce component breakdown, data model and interface contracts.",
      priority: "HIGH",
      assignee: "architect",
      estimate: 5,
      acceptance: ["Architecture documented", "Interfaces defined", "Tradeoffs noted"],
    });
    add({
      title: "Implement backend services & API",
      description: "Build the API endpoints and data layer per the architecture.",
      priority: "HIGH",
      assignee: "backend-engineer",
      estimate: 8,
      acceptance: ["Endpoints implemented", "Validation added", "Unit tests pass"],
    });
    add({
      title: "Implement frontend UI",
      description: "Build the user-facing interface and wire it to the API.",
      priority: "MEDIUM",
      assignee: "frontend-engineer",
      estimate: 7,
      acceptance: ["UI implemented", "Wired to API", "Responsive & accessible"],
    });
    add({
      title: "Write & run test suite",
      description: "Cover critical paths with unit and integration tests; validate acceptance criteria.",
      priority: "MEDIUM",
      assignee: "qa-engineer",
      estimate: 4,
      acceptance: ["Critical paths covered", "All tests green", "Acceptance criteria validated"],
    });
    add({
      title: "Deploy to staging & run health checks",
      description: "Ship through the pipeline: build, test, security scan, deploy, health check.",
      priority: "MEDIUM",
      assignee: "devops",
      estimate: 3,
      acceptance: ["Pipeline green", "Health checks pass"],
    });
  }

  const strategy =
    `Strategy: break "${goal}" into ${base.length} parallelizable tasks across the team, ` +
    `front-loading design and risk reduction, then implementation, verification and release.`;
  return { strategy, tasks: base };
}

function simArchitecture(prompt: string, rnd: () => number): string {
  const patterns = [
    "layered service architecture with a stateless API tier",
    "event-driven architecture with a lightweight message bus",
    "modular monolith with clear bounded contexts",
  ];
  const stores = ["PostgreSQL for transactional data", "Redis for caching and queues", "an object store for assets"];
  return [
    `Architecture decision: adopt a ${pick(patterns, rnd)}.`,
    ``,
    `Components:`,
    `- API Gateway / WAF — request validation, rate limiting`,
    `- Application service — core business logic`,
    `- Auth service — token issuance & verification`,
    `- Data layer — ${take(stores, 2, rnd).join(", ")}`,
    ``,
    `Key tradeoffs: favor operational simplicity and clear contracts; defer sharding until load warrants it. ` +
      `Security controls (authn, authz, input validation) are built into the service boundary from day one.`,
  ].join("\n");
}

function simCode(prompt: string, rnd: () => number): string {
  const p = prompt.toLowerCase();
  if (p.includes("auth") || p.includes("login") || p.includes("token")) {
    return [
      "// auth/token.ts — token verification middleware",
      "import { verifyJwt } from './jwt';",
      "",
      "export function requireAuth(handler) {",
      "  return async (req, res) => {",
      "    const token = req.headers.authorization?.replace('Bearer ', '');",
      "    if (!token) return res.status(401).json({ error: 'missing token' });",
      "    const claims = await verifyJwt(token);",
      "    if (!claims) return res.status(401).json({ error: 'invalid token' });",
      "    req.user = claims;",
      "    return handler(req, res);",
      "  };",
      "}",
    ].join("\n");
  }
  return [
    "// feature implementation (generated by Nova/Atlas)",
    "export async function handler(req, res) {",
    "  const input = parseAndValidate(req.body); // zod schema",
    "  const result = await service.execute(input);",
    "  return res.json({ ok: true, data: result });",
    "}",
  ].join("\n");
}

function simReview(rnd: () => number): string {
  const notes = [
    "LGTM — clean separation of concerns.",
    "Request change: validate input with a schema before use.",
    "Nit: extract the magic number into a named constant.",
    "Add a regression test for the error path.",
  ];
  return `Code review: ${take(notes, 2, rnd).join(" ")}`;
}

function simTest(rnd: () => number): { passed: number; failed: number; total: number; cases: { name: string; ok: boolean }[] } {
  const cases = [
    "renders without crashing",
    "rejects invalid input",
    "returns 401 without token",
    "persists valid record",
    "handles empty state",
    "enforces authorization",
  ];
  const chosen = take(cases, 4 + Math.floor(rnd() * 2), rnd);
  const failIdx = rnd() < 0.25 ? Math.floor(rnd() * chosen.length) : -1;
  const results = chosen.map((name, i) => ({ name, ok: i !== failIdx }));
  const failed = results.filter((r) => !r.ok).length;
  return { passed: results.length - failed, failed, total: results.length, cases: results };
}

const ATTACK_SCENARIOS = [
  { type: "SQL Injection", target: "Customer API", category: "application-security", severity: "CRITICAL", cvss: 9.1 },
  { type: "Insecure Direct Object Reference", target: "User API", category: "authorization", severity: "HIGH", cvss: 7.5 },
  { type: "Weak Authentication", target: "Auth Service", category: "authentication", severity: "HIGH", cvss: 7.8 },
  { type: "Exposed Debug Endpoint", target: "Admin Service", category: "application-security", severity: "MEDIUM", cvss: 6.1 },
  { type: "Reflected XSS", target: "Application", category: "application-security", severity: "MEDIUM", cvss: 5.9 },
  { type: "Leaked Test Secret", target: "Logging Service", category: "secrets", severity: "HIGH", cvss: 7.2 },
  { type: "Vulnerable Dependency", target: "Application", category: "dependencies", severity: "MEDIUM", cvss: 6.4 },
];

export function pickAttackScenario(seedStr: string) {
  const rnd = seededRandom(hashString(seedStr) || 1);
  return pick(ATTACK_SCENARIOS, rnd);
}

/** Look up a specific scenario by (fuzzy) attack type; falls back to seeded pick. */
export function scenarioByType(type: string, seedStr: string) {
  const t = type.toLowerCase();
  const match = ATTACK_SCENARIOS.find((s) => s.type.toLowerCase() === t || s.type.toLowerCase().includes(t) || t.includes(s.type.toLowerCase()));
  return match ?? pickAttackScenario(seedStr);
}

/** Build a full attack-scenario object (with steps/evidence/impact) for a given base. */
export function buildScenario(base: { type: string; target: string; category: string; severity: string; cvss: number }) {
  return {
    attackType: base.type,
    target: base.target,
    category: base.category,
    severity: base.severity,
    cvss: base.cvss,
    steps: [
      `Recon: enumerate ${base.target} endpoints inside the sandbox`,
      `Identify weakness: ${base.type.toLowerCase()} vector`,
      `Craft simulated payload against the toy ${base.target}`,
      `Observe response and record evidence`,
      `Assess simulated impact (no real data involved)`,
    ],
    evidence: `Simulated ${base.type} succeeded against toy ${base.target}; request/response captured in sandbox.`,
    impact: `Potential exposure of simulated data in ${base.target}. Contained to the cyber range.`,
    note: "SIMULATED — isolated AURA cyber range only. No real systems targeted.",
  };
}

function simAttack(prompt: string, rnd: () => number): object {
  const s = pick(ATTACK_SCENARIOS, rnd);
  return {
    attackType: s.type,
    target: s.target,
    category: s.category,
    severity: s.severity,
    cvss: s.cvss,
    steps: [
      `Recon: enumerate ${s.target} endpoints inside the sandbox`,
      `Identify weakness: ${s.type.toLowerCase()} vector`,
      `Craft simulated payload against the toy ${s.target}`,
      `Observe response and record evidence`,
      `Assess simulated impact (no real data involved)`,
    ],
    evidence: `Simulated ${s.type} succeeded against toy ${s.target}; request/response captured in sandbox.`,
    impact: `Potential exposure of simulated data in ${s.target}. Contained to the cyber range.`,
    note: "SIMULATED — isolated AURA cyber range only. No real systems targeted.",
  };
}

function simDefense(prompt: string, rnd: () => number): object {
  return {
    detected: true,
    detectionMethod: pick(
      ["anomalous query pattern", "WAF signature match", "auth failure spike", "egress anomaly"],
      rnd,
    ),
    containment: pick(
      ["isolated affected endpoint", "rotated simulated credentials", "enabled strict input validation", "blocked offending pattern at WAF"],
      rnd,
    ),
    remediation: "Deploy patch, add regression test, re-run security scan.",
    verified: true,
  };
}

function simDecision(prompt: string, rnd: () => number): object {
  return {
    options: [
      { label: "Proceed now", pros: ["Faster time to value"], cons: ["Higher risk"] },
      { label: "Harden first", pros: ["Lower risk", "Better reliability"], cons: ["Slower"] },
    ],
    choice: rnd() < 0.6 ? "Harden first" : "Proceed now",
    rationale:
      "Weighed runway, risk and customer impact against current metrics; chose the option that best protects reliability while preserving momentum.",
  };
}

function simCeo(prompt: string, rnd: () => number): string {
  return (
    "Based on current metrics: we're executing against the roadmap with healthy velocity. " +
    "The main watch-items are security posture and technical debt. " +
    "I recommend we keep shipping incrementally, keep the cyber range exercises running, and reinvest a portion of revenue into reliability."
  );
}

function simAnalysis(prompt: string, rnd: () => number): string {
  // Context-aware path for code triage: point at what the supplied source actually does.
  if (/Math\.floor\(/.test(prompt) && /cents?/i.test(prompt)) {
    const negatives = !/quantity\s*<\s*1|quantity\s*<=\s*0/.test(prompt);
    return (
      "Likely cause: the total is computed in floating-point dollars and converted with Math.floor(total * 100). " +
      "Values such as 0.29 are stored as 0.28999…, so flooring drops a cent (undercharge)." +
      (negatives ? " Quantity is not validated, so a negative quantity yields a negative charge." : "") +
      " Recommended fix: compute in integer cents and validate inputs; confirm with the regression tests before release."
    );
  }
  return (
    "Analysis: trajectory is positive. Revenue is correlating with customer growth; " +
    "watch churn and incident frequency as leading indicators. Recommend a focus sprint on the highest-severity open finding."
  );
}

function simSummary(prompt: string, rnd: () => number): string {
  const verbs = ["Analyzing", "Reviewing", "Implementing", "Validating", "Investigating", "Designing"];
  const nouns = ["authentication flow", "data model", "API contract", "test coverage", "deployment pipeline", "security posture"];
  return `${pick(verbs, rnd)} ${pick(nouns, rnd)}.`;
}


// ---- Mission tasks: structured JSON derived ONLY from the supplied context ----

/** Pull a "# Heading" section out of an assembled mission context. */
function section(prompt: string, heading: string): string {
  const m = prompt.match(new RegExp(`# ${heading}\\n([\\s\\S]*?)(?=\\n# |$)`));
  return m ? m[1].trim() : "";
}

function simMissionTask(kind: string, prompt: string): Record<string, unknown> {
  const objective = section(prompt, "Mission objective") || "the mission objective";
  const code = section(prompt, "Code");
  const files = [...code.matchAll(/^\/\/ (src\/[^\s]+)$/gm)].map((x) => x[1]);
  const evidence = section(prompt, "Latest test evidence \\(system-recorded\\)");
  const failing = [...evidence.matchAll(/^FAIL (.+)$/gm)].map((x) => x[1]);
  const findings = section(prompt, "Open findings you must address");
  const findingIds = [...findings.matchAll(/^(F-\d+) /gm)].map((x) => x[1]);
  switch (kind) {
    case "REQUIREMENTS":
      return {
        requirements: [`Resolve: ${objective.slice(0, 200)}`, "Keep the change minimal and inside the declared write scope"],
        acceptanceCriteria: ["The failing test passes in the sandbox", "No previously passing test regresses", "An independent reviewer finds no blocking issue"],
        openQuestions: ["Should non-integer quantities be rejected or rounded? (assumed: rejected)"],
        constraints: ["No new dependencies", "Validation returns errors; it must not throw for bad input"],
      };
    case "ARCHITECTURE": {
      const suspect = /quantity < 0/.test(code) ? "quantity is only checked with `< 0`, so 0 (and non-numbers) pass validation" : /Math\.floor\(/.test(code) ? "amounts are floored in floating point, losing a cent" : "see failing tests";
      return {
        proposal: `Change the quantity check in ${files[0] ?? "the module"}: ${suspect}. Keep the public contract of validateCart unchanged.`,
        affectedFiles: files.length ? files.slice(0, 3) : ["(unknown)"],
        interfaceChanges: [],
        risks: ["Tightening validation may reject carts that clients currently send"],
        recommendations: ["Add a regression test for the reported input", "Type-check numeric fields, not only range-check them"],
      };
    }
    case "ANALYSIS":
      return { summary: `Analysis of: ${objective.slice(0, 300)}`, suspectedCause: "", affectedFiles: files.slice(0, 5), recommendations: ["Attach an executable codebase to verify any change"] };
    case "CODE_CHANGE":
      return { summary: `Applying the prepared repair${findingIds.length ? ` for ${findingIds.join(", ")}` : ""}${failing.length ? `; failing before: ${failing.join("; ")}` : ""}.`, addresses: findingIds };
    case "REVIEW": {
      // Raise a concern for every listed probe (a cautious reviewer), plus one with no executable evidence.
      // The ENGINE runs each probe and decides which concerns are supported.
      const task = section(prompt, "Your task");
      const probes = [...task.matchAll(/^- ([a-z0-9-]+): (.+)$/gm)].map((x) => ({ id: x[1], description: x[2] }));
      return {
        summary: "Reviewed the diff against the objective and acceptance criteria.",
        concerns: [
          ...probes.map((p) => ({ probe: p.id, severity: "HIGH", blocking: true, title: `${p.description} — may not hold`, rationale: "Range comparisons do not type-check their input." })),
          { probe: "error-message-echo", severity: "LOW", blocking: true, title: "Error messages might echo raw input", rationale: "Not verified." },
        ],
      };
    }
    case "REPORT":
      return { summary: `Mission report for: ${objective.slice(0, 300)}. See the recorded evidence below.`, unresolved: [] };
  }
  return {};
}
