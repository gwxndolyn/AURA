/**
 * Evidence-based failure attribution (pure, deterministic, versioned).
 *
 * Input: what was actually recorded for one failed attempt — classified
 * defects from real command output, engine findings (gate, impact, browser,
 * reviewers), unmet criteria, the attempt's diff paths, the task's planned
 * files, prior attempts of the same run, and whether the change compiled at
 * all. Output: zero or more attributions, each with
 *
 *   category    what kind of failure (taxonomy below)
 *   scope       agent | workflow | environment | external | unknown — an agent
 *               is never blamed for infrastructure or provider failures
 *   rootCause   the EARLIEST supported explanation (not the last symptom)
 *   symptoms    what was observed downstream of it
 *   evidence    [{kind, ref, detail}] pointing at stored records
 *   confidence  low | medium | high from the strength of the evidence
 *   status      ESTABLISHED (direct evidence) | HYPOTHESIS (indirect) | UNKNOWN
 *   corrective  the action AURA takes next (verified later by the next attempt)
 *
 * When nothing supports a cause, the result is UNKNOWN — never a guess.
 */

export const ATTRIBUTION_RULES_VERSION = "attr-1";

export const ATTRIBUTION_CATEGORIES = [
  "requirements_ambiguous",
  "planning_missing_dependency",
  "architecture_contract",
  "context_insufficient",
  "code_generation",
  "repository_assumption",
  "tool_failure",
  "environment",
  "inadequate_tests",
  "integration_conflict",
  "security_defect",
  "reviewer_incorrect",
  "intent_mismatch",
  "provider_failure",
  "unknown",
] as const;
export type AttributionCategory = (typeof ATTRIBUTION_CATEGORIES)[number];
export type Scope = "agent" | "workflow" | "environment" | "external" | "unknown";

export interface AttributionInput {
  attempt: number;
  ownerAgent: string;
  promptRef?: string | null;
  defects: { signature: string; category: string; title: string; occurrences: number; files: string[]; failingTests: string[]; commandRunId: string; diagnosis: string }[];
  findings: { source: string; severity: string; title: string; detail: string; evidence: string; blocking: boolean }[];
  unmet: { text: string; evidence: string }[];
  changed: string[];
  plannedFiles: string[];
  impactFlags: { kind: string; confidence: string; detail: string }[];
  knownFiles: string[];
  error?: { kind: string; message: string } | null; // JobError of an interrupted attempt
  previous: { attempt: number; categories: string[]; treeUnchanged?: boolean }[];
}

export interface Attribution {
  category: AttributionCategory;
  scope: Scope;
  agentKey: string | null;
  rootCause: string;
  symptoms: string[];
  evidence: { kind: string; ref: string; detail: string }[];
  confidence: "low" | "medium" | "high";
  status: "ESTABLISHED" | "HYPOTHESIS" | "UNKNOWN";
  correctiveAction: string;
}

const ev = (kind: string, ref: string, detail: string) => ({ kind, ref, detail: detail.slice(0, 400) });

/** Paths a stack trace / error mentions that do not exist in the repository (assumed files or modules). */
function missingReferences(defects: AttributionInput["defects"], known: string[]) {
  const out: string[] = [];
  for (const d of defects) for (const m of `${d.title}\n${d.diagnosis}`.matchAll(/Cannot find module '(\.{1,2}\/[^']+)'|ENOENT[^']*'([^']+)'/g)) out.push(m[1] ?? m[2]);
  return out.filter((p) => !known.some((k) => k.endsWith(p.replace(/^\.{1,2}\//, ""))));
}

export function attribute(i: AttributionInput): Attribution[] {
  const out: Attribution[] = [];
  const add = (a: Omit<Attribution, "agentKey"> & { agentKey?: string | null }) => out.push({ agentKey: a.scope === "agent" ? (a.agentKey ?? i.ownerAgent) : null, ...a } as Attribution);

  // 1. Interrupted attempts: provider / environment / budget are never the agent's fault.
  if (i.error) {
    const k = i.error.kind;
    if (/provider|rate_limit|overloaded|api_error|model/.test(k)) add({ category: "provider_failure", scope: "external", rootCause: `The model provider failed (${k}): ${i.error.message.slice(0, 200)}`, symptoms: ["attempt interrupted before verification"], evidence: [ev("job_error", k, i.error.message)], confidence: "high", status: "ESTABLISHED", correctiveAction: "retry with backoff; no prompt or code change" });
    else if (/sandbox|infrastructure|docker|unavailable|limitation/.test(k)) add({ category: "environment", scope: "environment", rootCause: `The execution environment failed (${k}): ${i.error.message.slice(0, 200)}`, symptoms: ["no command result"], evidence: [ev("job_error", k, i.error.message)], confidence: "high", status: "ESTABLISHED", correctiveAction: "re-queue when the sandbox is available; no code change" });
    else if (k === "merge_conflict") add({ category: "integration_conflict", scope: "workflow", rootCause: i.error.message.slice(0, 300), symptoms: [], evidence: [ev("job_error", k, i.error.message)], confidence: "high", status: "ESTABLISHED", correctiveAction: "a person reconciles the conflicting branches; scheduler should not have run overlapping files in parallel" });
    else if (k === "command_refused" || k === "tool") add({ category: "tool_failure", scope: "workflow", rootCause: i.error.message.slice(0, 300), symptoms: [], evidence: [ev("job_error", k, i.error.message)], confidence: "medium", status: "ESTABLISHED", correctiveAction: "check tool allowlist/arguments in the prompt's tool description" });
    return out;
  }

  // 2. Environment-class defects from real command output.
  for (const d of i.defects.filter((x) => ["infrastructure", "permissions"].includes(x.category))) add({ category: "environment", scope: "environment", rootCause: d.diagnosis, symptoms: [d.title], evidence: [ev("command_run", d.commandRunId, d.title)], confidence: "high", status: "ESTABLISHED", correctiveAction: "retry when the environment recovers" });

  // 3. Repository assumptions: errors referencing files/modules that do not exist.
  const missing = missingReferences(i.defects, i.knownFiles);
  if (missing.length) add({ category: "repository_assumption", scope: "agent", rootCause: `The code references ${missing.slice(0, 3).join(", ")}, which does not exist in the repository`, symptoms: i.defects.map((d) => d.title).slice(0, 3), evidence: i.defects.slice(0, 3).map((d) => ev("command_run", d.commandRunId, d.title)), confidence: "high", status: "ESTABLISHED", correctiveAction: "inspect the repository (fs_list/fs_read) before importing; include the code map and module paths in context" });

  // 4. Dependency/configuration defects.
  for (const d of i.defects.filter((x) => x.category === "dependency" || x.category === "configuration")) if (!missing.length) add({ category: d.category === "dependency" ? "environment" : "repository_assumption", scope: d.category === "dependency" ? "workflow" : "agent", rootCause: d.diagnosis, symptoms: [d.title], evidence: [ev("command_run", d.commandRunId, d.title)], confidence: "medium", status: "ESTABLISHED", correctiveAction: d.category === "dependency" ? "use built-ins or declare the package with an exact version" : "align scripts/module format with the project's conventions" });

  // 5. Test-environment assumptions.
  for (const d of i.defects.filter((x) => x.category === "test_assumption")) add({ category: "inadequate_tests", scope: "agent", rootCause: `Tests depend on network, fixed ports or timing: ${d.diagnosis}`, symptoms: [d.title], evidence: [ev("command_run", d.commandRunId, d.title)], confidence: "medium", status: "ESTABLISHED", correctiveAction: "ephemeral ports, no external network, no sleeps" });

  // 6. Code defects: assertion failures in tests that exercise the change.
  const code = i.defects.filter((x) => x.category === "code" || x.category === "timeout");
  if (code.length) {
    const inChanged = code.filter((d) => d.files.some((f) => i.changed.includes(f)));
    const recurring = code.some((d) => d.occurrences >= 2);
    const priorSame = i.previous.some((p) => p.categories.includes("code_generation"));
    add({ category: "code_generation", scope: "agent", rootCause: recurring && priorSame ? `The same defect survived a repair: the previous fix addressed the wrong cause (${code[0].title})` : `The implementation does not satisfy its tests: ${code[0].title}`, symptoms: code.map((d) => d.title).slice(0, 4), evidence: code.slice(0, 4).map((d) => ev("command_run", d.commandRunId, `${d.title}${d.files.length ? ` — ${d.files.slice(0, 3).join(", ")}` : ""}`)), confidence: inChanged.length ? "high" : "medium", status: inChanged.length || code[0].failingTests.length ? "ESTABLISHED" : "HYPOTHESIS", correctiveAction: recurring ? "re-derive the root cause from the failing test (rethink strategy, stronger model); do not repeat the previous fix" : "fix the code under test, not the test" });
  }

  // 7. Engine findings that are not command failures.
  const gate = i.findings.filter((f) => f.blocking && f.source === "verification" && /gate/.test(f.title));
  if (gate.length) add({ category: "inadequate_tests", scope: "agent", rootCause: `The verification gate rejected the tests: ${gate.map((g) => g.detail).join("; ").slice(0, 300)}`, symptoms: gate.map((g) => g.title), evidence: gate.map((g) => ev("finding", "gate", g.title)), confidence: "high", status: "ESTABLISHED", correctiveAction: "write falsifiable assertions that exercise the behaviour; never weaken existing tests" });
  const security = i.findings.filter((f) => f.blocking && f.source === "security" && f.evidence.trim());
  if (security.length) add({ category: "security_defect", scope: "agent", rootCause: security[0].title, symptoms: security.map((s) => s.title), evidence: security.map((s) => ev("finding", "security", `${s.title}: ${s.evidence}`)), confidence: "medium", status: "ESTABLISHED", correctiveAction: "fix the cited code; add a test proving the control blocks the bad case" });
  const browser = i.findings.filter((f) => f.blocking && f.source === "browser");
  if (browser.length) {
    const persistence = browser.some((b) => /journey|persist|not refreshed|never displayed/.test(b.title + b.detail));
    add({ category: persistence ? "architecture_contract" : "code_generation", scope: "agent", rootCause: persistence ? `The UI is not consistent with the API contract: ${browser.find((b) => /journey/.test(b.title))?.detail ?? browser[0].detail}` : `The rendered UI has defects: ${browser.map((b) => b.title).join("; ")}`.slice(0, 400), symptoms: browser.map((b) => `${b.title}: ${b.detail}`.slice(0, 200)), evidence: browser.map((b) => ev("browser", b.evidence, b.title)), confidence: "high", status: "ESTABLISHED", correctiveAction: persistence ? "after each mutation re-fetch from the API and render; verify create → reload in the browser" : "fix the reported route/viewport issues (labels, overflow, errors)" });
  }
  const impact = i.impactFlags.filter((f) => f.confidence === "confirmed");
  if (impact.length) add({ category: impact.some((f) => /contract|api_breaking|route/.test(f.kind)) ? "architecture_contract" : "context_insufficient", scope: "agent", rootCause: `The change breaks existing code: ${impact[0].detail}`, symptoms: impact.map((f) => f.kind), evidence: impact.map((f) => ev("impact", f.kind, f.detail)), confidence: "high", status: "ESTABLISHED", correctiveAction: "include dependents and their tests in the context; keep the existing contract" });

  // 8. Scope creep vs planned files (only when a plan exists and nothing else explains the failure).
  const outside = i.plannedFiles.length ? i.changed.filter((c) => !i.plannedFiles.includes(c) && !/\.test\.|package(-lock)?\.json$/.test(c)) : [];
  if (outside.length >= 3 && !out.length) add({ category: "context_insufficient", scope: "agent", rootCause: `The attempt changed ${outside.length} files outside the planned scope (${outside.slice(0, 4).join(", ")})`, symptoms: [], evidence: [ev("diff", "changed", outside.join(", "))], confidence: "low", status: "HYPOTHESIS", correctiveAction: "show the planned files and their neighbours first; ask the engineer to explain extra changes" });

  // 9. Unproven criteria with otherwise green checks: inadequate tests (or ambiguous requirement).
  if (!out.length && i.unmet.length) {
    const vague = i.unmet.filter((u) => u.text.split(/\s+/).length < 5 || !/\b(return|show|reject|display|persist|list|=|\d|status|error|when|after)\b/i.test(u.text));
    if (vague.length === i.unmet.length) add({ category: "requirements_ambiguous", scope: "workflow", rootCause: `Acceptance criteria are not testable as written: ${vague.map((v) => `"${v.text}"`).slice(0, 3).join(", ")}`, symptoms: [], evidence: vague.map((v) => ev("criterion", "acceptance", v.text)), confidence: "low", status: "HYPOTHESIS", correctiveAction: "clarify the criterion into an observable behaviour" });
    else add({ category: "inadequate_tests", scope: "agent", rootCause: `${i.unmet.length} acceptance criteria were not proven by any executed check`, symptoms: i.unmet.map((u) => u.text).slice(0, 4), evidence: i.unmet.slice(0, 4).map((u) => ev("criterion", "qa", `${u.text} — ${u.evidence}`)), confidence: "medium", status: "ESTABLISHED", correctiveAction: "add tests that exercise each unproven criterion through the real API/UI" });
  }

  // 10. No change at all / identical tree.
  if (!i.changed.length) add({ category: "code_generation", scope: "agent", rootCause: "The attempt changed no files", symptoms: [], evidence: [ev("diff", "changed", "empty")], confidence: "high", status: "ESTABLISHED", correctiveAction: "the engineer must write files with the tools" });

  if (!out.length) add({ category: "unknown", scope: "unknown", rootCause: "The recorded evidence does not support a specific cause", symptoms: i.findings.filter((f) => f.blocking).map((f) => f.title).slice(0, 4), evidence: [], confidence: "low", status: "UNKNOWN", correctiveAction: "collect more evidence on the next attempt (full test output, browser run)" });
  // Most specific first; one row per category.
  const seen = new Set<string>();
  return out.filter((a) => (seen.has(a.category) ? false : (seen.add(a.category), true)));
}
