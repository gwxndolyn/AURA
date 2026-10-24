/** Plain-language definitions shown wherever these terms appear in the UI. */
export const GLOSSARY = {
  mission: "A goal you give the agent team. AURA turns it into a plan, runs the plan step by step, and records evidence for every result.",
  plan: "The ordered list of tasks AURA proposes for a mission, with who does each one and which tools they may use. Nothing runs until a person approves it.",
  dependency: "A task that must succeed before another can start. If it fails, everything that depends on it is skipped.",
  agent: "An AI team member with a fixed role (QA, backend, security…) and a fixed set of tools it is allowed to use.",
  tool: "A concrete action an agent takes, like reading code or running tests. Each call is checked against the agent's role and logged.",
  gate: "A point where the mission stops and waits for a person. Agents cannot approve their own work.",
  verification: "Evidence that a task did what it claimed — for code, a real test run in the Docker sandbox. Without it, a result is marked unverified.",
  artifact: "A recorded output of a task: a test report, a diff, a file version, an analysis. Artifacts are versioned and never overwritten.",
  autonomy: "How much the agent team may do without asking. In AURA, plan approval and release approval are always required.",
  evaluation: "A repeatable test of an agent's behaviour against a fixed dataset, scored so prompt or model changes can be compared.",
  cyberRange: "An isolated, in-process practice environment. The red team only attacks AURA's own toy targets — never a real system.",
  sandbox: "A locked-down Docker container (no network, read-only, time-limited) where generated code and tests actually run.",
  simulator: "With no API key, agents use a deterministic local model. Their text is simulated; test runs in the sandbox are still real.",
} as const;
export type GlossaryKey = keyof typeof GLOSSARY;

export const GLOSSARY_LABEL: Record<GlossaryKey, string> = {
  mission: "Mission",
  plan: "Plan",
  dependency: "Task dependency",
  agent: "Agent",
  tool: "Tool execution",
  gate: "Approval gate",
  verification: "Verification",
  artifact: "Artifact",
  autonomy: "Autonomy level",
  evaluation: "Evaluation",
  cyberRange: "Cyber range",
  sandbox: "Sandbox",
  simulator: "Simulator",
};
