/**
 * Mission task executor.
 *
 * One call = one attempt of one task, recorded as a MissionTaskRun:
 *   1. assemble context (capability-declared kinds, budgeted, provenance kept)
 *   2. enforce per-task + mission budget BEFORE every model call
 *   3. run the kind's work through real tools (callTool → sandbox, probes…)
 *   4. build the structured output from tool evidence, validate it against
 *      the kind contract; model prose is stored only as a claim
 *   5. persist a validated handoff for dependents
 *
 * The engine (engine.ts) owns scheduling, leases, state transitions and the
 * repair loop; this module returns an outcome the engine acts on.
 */
import { prisma } from "@/lib/db";
import { runAgent, BudgetExceededError, type RunAgentResult } from "@/lib/agents/orchestrator";
import { callTool, PermissionError, ToolError } from "@/lib/agents/tools";
import { capabilityFor } from "@/lib/agents/capabilities";
import { validateOutput, validateHandoff, extractJson, FindingDraftSchema, type Handoff, type TestEvidence } from "@/lib/agents/contracts";
import { runNodeSuite, dockerAvailable, type TestRunResult } from "@/lib/sandbox/runner";
import { sendMessage } from "@/lib/agents/messaging";
import { aiMode } from "@/lib/ai/claude";
import { detectRefusal, PolicyRefusalError } from "@/lib/intelligence/policy";
import { parseJSON } from "@/lib/utils";
import { lineDiff } from "./diff";
import { assembleContext, currentFiles, ContextOverflowError, MissingContextError, type AssembledContext } from "./context";
import { repoFor, sandboxName, type FixtureRepo, type Probe } from "./repos";
import { addArtifact, accrue, event, hashFiles, nextFindingCode, type Mission, type Task, type Run } from "./store";
import { takeFault } from "./faults";

export type Outcome =
  | { status: "SUCCEEDED"; verification: "PASSED" | "NONE"; summary: string; outcome: string }
  | { status: "FAILED"; category: string; error: string; verification?: "FAILED" | "UNVERIFIED" | "NONE"; retryable: boolean; outcome?: string }
  | { status: "WAITING_APPROVAL"; summary: string }
  /** QA or review found a problem that the repair loop can address. */
  | { status: "REPAIR"; reason: string; findingCodes: string[]; summary: string; verification: "FAILED"; outcome: string };

export class TaskBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskBudgetError";
  }
}

export class CancelledError extends Error {
  constructor() {
    super("Mission was cancelled; no further model or tool calls are made");
    this.name = "CancelledError";
  }
}

class InvalidOutputError extends Error {
  constructor(public errors: string[], public raw: string) {
    super(`Structured output failed validation: ${errors.slice(0, 4).join("; ")}`);
    this.name = "InvalidOutputError";
  }
}

class RefusalError extends Error {
  constructor(public raw: string) {
    super("Agent refused or could not complete the task");
    this.name = "RefusalError";
  }
}

interface Exec {
  m: Mission;
  t: Task;
  run: Run;
  ctx: AssembledContext;
  repo: FixtureRepo | null;
  usage: { modelCalls: number; toolCalls: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number; cost: number; latencyMs: number; estimated: boolean; modes: Set<string>; models: Set<string>; tier: string; runIds: string[] };
  toolLog: { tool: string; status: string; durationMs: number; error?: string }[];
  claims: string[];
}

/** What each kind's model call must return (live mode). The engine validates the result. */
const CONTRACT_HINT: Record<string, string> = {
  REQUIREMENTS: '{"requirements": string[], "acceptanceCriteria": string[], "openQuestions": string[], "constraints": string[]}',
  ARCHITECTURE: '{"proposal": string, "affectedFiles": string[] (repository paths), "interfaceChanges": string[], "risks": string[], "recommendations": string[]}',
  ANALYSIS: '{"summary": string, "suspectedCause": string, "affectedFiles": string[], "recommendations": string[]}',
  CODE_CHANGE: '{"summary": string, "addresses": string[] (finding ids), "files": [{"path": string (inside your write scope), "content": string (the full new file)}]}',
  REVIEW: '{"summary": string, "concerns": [{"probe": string (one of the listed probe ids), "severity": "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", "blocking": boolean, "title": string, "rationale": string}]}',
  REPORT: '{"summary": string, "unresolved": string[]}',
};

// ---------------------------------------------------------------------------
// Budget, model, tools
// ---------------------------------------------------------------------------

/** Hard stop before every model call: per-task budget and remaining mission budget. */
async function guardBudget(x: Exec) {
  const fresh = await prisma.mission.findUnique({ where: { id: x.m.id }, select: { costUsd: true, budgetUsd: true, status: true } });
  if (!fresh || fresh.status === "CANCELLED") throw new CancelledError();
  if (fresh.costUsd >= fresh.budgetUsd) throw new TaskBudgetError(`mission budget exhausted ($${fresh.costUsd.toFixed(4)} of $${fresh.budgetUsd})`);
  const spentOnTask = (await prisma.missionTaskRun.aggregate({ where: { missionId: x.m.id, taskKey: x.t.key, id: { not: x.run.id } }, _sum: { costUsd: true } }))._sum.costUsd ?? 0;
  if (spentOnTask + x.usage.cost >= x.t.budgetUsd) throw new TaskBudgetError(`task budget exhausted ($${(spentOnTask + x.usage.cost).toFixed(4)} of $${x.t.budgetUsd})`);
}

/**
 * Call the task's agent with assembled context and parse a JSON object.
 * Invalid JSON → InvalidOutputError (retryable per capability); refusal → RefusalError.
 */
async function callModel(x: Exec, objective: string): Promise<{ obj: Record<string, unknown>; r: RunAgentResult }> {
  await guardBudget(x);
  const cap = capabilityFor(x.t.agentKey);
  const r = await runAgent({
    companyId: x.m.companyId,
    agentKey: x.t.agentKey,
    objective,
    kind: `mission:${x.t.kind}`,
    tier: cap?.tier,
    assembledContext: x.ctx.text,
    context: `Respond with ONE JSON object only: ${CONTRACT_HINT[x.t.kind] ?? "{}"}. Do not claim tests passed — test results are recorded by the system.`,
    maxTokens: 1500,
  });
  x.usage.modelCalls++;
  x.usage.tokensIn += r.tokensIn;
  x.usage.tokensOut += r.tokensOut;
  x.usage.cacheRead += r.cacheReadTokens;
  x.usage.cacheWrite += r.cacheWriteTokens;
  x.usage.cost += r.cost;
  x.usage.latencyMs += r.latencyMs;
  x.usage.estimated ||= r.usageSource !== "provider";
  x.usage.modes.add(r.mode);
  x.usage.models.add(r.model);
  x.usage.tier = r.tier;
  x.usage.runIds.push(r.runId);
  await accrue(x.m.id, { cost: r.cost, modelCalls: 1 });

  let text = r.text;
  const fault = takeFault(x.m.id, x.t.key, "model");
  if (fault?.mode === "malformed") text = "Sure! Here is my analysis: {affectedFiles: [src/checkout";
  if (fault?.mode === "refusal") text = "I can't help with that request.";
  if (fault?.mode === "unexpected") text = JSON.stringify({ result: 42, note: "unexpected shape" });

  if (detectRefusal(text) && !text.trim().startsWith("{")) throw new RefusalError(text);
  const obj = extractJson(text);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new InvalidOutputError(["response contained no JSON object"], text.slice(0, 500));
  return { obj: obj as Record<string, unknown>, r };
}

/** callTool with fault injection, usage accounting and a tool log entry. */
async function tool<T>(x: Exec, name: string, args: Record<string, unknown>, impl: () => Promise<T>, runId?: string): Promise<T> {
  const fault = takeFault(x.m.id, x.t.key, "tool", name);
  const started = Date.now();
  const wrapped: () => Promise<T> = fault
    ? fault.mode === "timeout"
      ? () => new Promise<T>(() => {})
      : fault.mode === "error"
        ? async () => {
            throw new Error("tool backend unavailable (injected)");
          }
        : async () => ({ malformed: true }) as unknown as T
    : impl;
  const rid = runId ?? x.usage.runIds[x.usage.runIds.length - 1] ?? (await ensureToolRun(x));
  try {
    const out = await callTool(
      { companyId: x.m.companyId, agentKey: x.t.agentKey, runId: rid, writeScope: parseJSON<string[]>(x.t.files, []), timeoutMs: fault?.mode === "timeout" ? 50 : toolTimeoutOverride(x.m, name) },
      name,
      args,
      wrapped,
    );
    x.toolLog.push({ tool: name, status: "ok", durationMs: Date.now() - started });
    return out;
  } catch (e) {
    x.toolLog.push({ tool: name, status: e instanceof ToolError ? e.code : e instanceof PermissionError ? "denied" : "error", durationMs: Date.now() - started, error: (e as Error).message.slice(0, 300) });
    throw e;
  } finally {
    x.usage.toolCalls++;
    await accrue(x.m.id, { toolCalls: 1 });
  }
}

/** Per-mission tool timeout overrides (operator-set at creation, bounded by the API). */
function toolTimeoutOverride(m: Mission, tool: string): number | undefined {
  const v = parseJSON<Record<string, number>>(m.toolTimeouts, {})[tool];
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------

async function sandboxUp(x: Exec): Promise<boolean> {
  if (takeFault(x.m.id, x.t.key, "docker")) return false;
  return dockerAvailable();
}

function evidenceOf(artifactId: string, res: TestRunResult): TestEvidence {
  return { artifactId, mode: res.mode, passed: res.passed, failed: res.failed, total: Math.max(1, res.total), failing: res.cases.filter((c) => !c.ok).map((c) => c.name) };
}

async function runSuite(x: Exec, repo: FixtureRepo, label: string): Promise<{ res: TestRunResult; ev: TestEvidence; codeHash: string }> {
  const files = await currentFiles(x.m.id, repo);
  const flat = Object.fromEntries(Object.entries(files).map(([p, c]) => [sandboxName(p), c]));
  const res = await tool(x, "test.run", { suite: repo.testFiles[0], label }, () => runNodeSuite(flat));
  const a = await addArtifact(x.m, x.t.key, "TEST_REPORT", `${repo.id} tests — ${label}`, res.output || "(no output)", {
    mode: res.mode, passed: res.passed, failed: res.failed, total: res.total, cases: res.cases, durationMs: res.durationMs, timedOut: res.timedOut ?? false, runId: x.run.id,
  });
  return { res, ev: evidenceOf(a.id, res), codeHash: hashFiles(files, repo.sourceFiles) };
}

/** Run one reviewer probe for real: a node:test file exercising the changed module. */
async function runProbe(x: Exec, repo: FixtureRepo, probe: Probe): Promise<{ pass: boolean; artifactId: string; res: TestRunResult }> {
  const files = await currentFiles(x.m.id, repo);
  const mod = sandboxName(probe.file);
  const testFile = `const test = require('node:test');\nconst assert = require('node:assert');\nconst m = require('./${mod}');\ntest(${JSON.stringify(`probe ${probe.id}: ${probe.description}`)}, () => {\n  ${probe.test}\n});\n`;
  const res = await tool(x, "sandbox.exec", { probe: probe.id, files: [probe.file] }, () => runNodeSuite({ [mod]: files[probe.file], [`probe-${probe.id}.test.js`]: testFile }));
  const a = await addArtifact(x.m, x.t.key, "PROBE_RESULT", `probe ${probe.id}`, res.output || "(no output)", { probe: probe.id, description: probe.description, mode: res.mode, passed: res.passed, failed: res.failed, total: res.total, cases: res.cases, runId: x.run.id });
  return { pass: res.mode === "docker" && res.failed === 0 && res.total > 0, artifactId: a.id, res };
}

// ---------------------------------------------------------------------------
// Kind handlers — each returns a structured output + outcome
// ---------------------------------------------------------------------------

type Handled = { output: Record<string, unknown>; outcome: Outcome; findings?: string[]; decisions?: string[]; artifacts?: string[]; tests?: TestEvidence[]; nextAction?: string };

async function doRequirements(x: Exec): Promise<Handled> {
  const { obj } = await callModel(x, `Clarify requirements for: ${x.m.title}`);
  return { output: obj, outcome: { status: "SUCCEEDED", verification: "NONE", summary: `${(obj.acceptanceCriteria as unknown[] | undefined)?.length ?? 0} acceptance criteria, ${(obj.openQuestions as unknown[] | undefined)?.length ?? 0} open questions`, outcome: "requirements" }, nextAction: "Locate the defect and propose a change boundary" };
}

async function doArchitecture(x: Exec): Promise<Handled> {
  const repo = x.repo!;
  // The architect must actually read the files it reasons about.
  const files = await currentFiles(x.m.id, repo);
  for (const f of [...repo.sourceFiles, ...repo.testFiles]) {
    await tool(x, "code.read", { path: f, reason: "locate defect" }, async () => ({ path: f, bytes: files[f].length, lines: files[f].split("\n").length }));
  }
  const { obj } = await callModel(x, `Locate the defect and propose a boundary: ${x.m.title}`);
  // Affected files must exist in the repository; anything else is an unsupported claim.
  const claimed = Array.isArray(obj.affectedFiles) ? (obj.affectedFiles as string[]) : [];
  const real = claimed.filter((f) => f in repo.files);
  if (claimed.length !== real.length) x.claims.push(`Architect named non-existent files: ${claimed.filter((f) => !(f in repo.files)).join(", ")}`);
  obj.affectedFiles = real;
  return { output: obj, outcome: { status: "SUCCEEDED", verification: "NONE", summary: `Proposal names ${real.join(", ") || "no real files"}`, outcome: "proposal" }, decisions: [String(obj.proposal ?? "").slice(0, 300)], nextAction: "Implement the change inside the write scope" };
}

async function doReproduce(x: Exec): Promise<Handled> {
  const repo = x.repo!;
  if (!(await sandboxUp(x))) return sandboxDown(x, "the defect could not be reproduced by running tests");
  const { res, ev } = await runSuite(x, repo, "current code (before fix)");
  const output = { reproduced: res.failed > 0, tests: ev };
  if (res.failed > 0) return { output, tests: [ev], findings: [`${res.failed}/${res.total} tests fail on the current code: ${ev.failing.join("; ")}`], outcome: { status: "SUCCEEDED", verification: "PASSED", summary: `Reproduced: ${res.failed}/${res.total} tests fail on current code — ${ev.failing.join("; ")}`, outcome: "reproduced" }, nextAction: "Fix the failing behaviour" };
  return { output, tests: [ev], outcome: { status: "FAILED", category: "evaluation_failure", error: `Could not reproduce: all ${res.total} tests pass on current code`, verification: "FAILED", retryable: false, outcome: "not_reproduced" } };
}

async function doCodeChange(x: Exec): Promise<Handled> {
  const repo = x.repo!;
  const scope = parseJSON<string[]>(x.t.files, []);
  const open = await prisma.missionFinding.findMany({ where: { missionId: x.m.id, status: "OPEN", blocking: true }, orderBy: { createdAt: "asc" } });
  const { obj, r } = await callModel(x, `Implement the fix (attempt ${x.run.attempt})${open.length ? ` addressing ${open.map((f) => f.code).join(", ")}` : ""}`);
  x.claims.push(String(obj.summary ?? "").slice(0, 600));

  // Determine the change: live model output (full file contents), else the prepared candidate for this round.
  const live = r.mode === "live" && Array.isArray(obj.files);
  const fault = takeFault(x.m.id, x.t.key, "candidate");
  let edits: { path: string; code: string; label: string }[];
  if (fault) edits = [{ path: scope[0], code: fault.code, label: "injected candidate" }];
  else if (live) edits = (obj.files as { path?: string; content?: string }[]).filter((f) => f.path && f.content).map((f) => ({ path: String(f.path), code: String(f.content), label: String(obj.summary ?? "model change").slice(0, 200) }));
  else {
    const idx = Math.min(x.m.repairRounds, repo.candidates.length - 1);
    const c = repo.candidates[idx];
    edits = [{ path: c.file, code: c.code, label: c.label }];
  }
  if (!edits.length) throw new InvalidOutputError(["no file edits in the engineer's output"], JSON.stringify(obj).slice(0, 500));

  const before = await currentFiles(x.m.id, repo);
  // Skip identical re-submissions: a repair that changes nothing is not a repair.
  const unchanged = edits.every((e) => before[e.path] === e.code);
  if (unchanged) return { output: {}, outcome: { status: "FAILED", category: "code_generation_failure", error: "Repair produced no change to the code (identical to the previous version)", retryable: false, outcome: "no_change" } };

  const filesOut = [];
  const addressed = open.map((f) => f.code);
  for (const e of edits) {
    await tool(x, "code.read", { path: e.path }, async () => ({ path: e.path, bytes: (before[e.path] ?? "").length, lines: (before[e.path] ?? "").split("\n").length }), r.runId);
    // Write scope is enforced in callTool; an out-of-scope path throws before anything is recorded as written.
    await tool(x, "code.write", { path: e.path, change: e.label, addresses: addressed }, async () => ({ path: e.path, bytes: e.code.length }), r.runId);
    const d = lineDiff(before[e.path] ?? "", e.code);
    const diffA = await addArtifact(x.m, x.t.key, "DIFF", `${e.path} (attempt ${x.run.attempt})`, d.text, { added: d.added, removed: d.removed, change: e.label, author: live ? "model-assisted" : "simulated-candidate", addresses: addressed, runId: x.run.id });
    const fileA = await addArtifact(x.m, x.t.key, "FILE", e.path, e.code, { attempt: x.run.attempt, change: e.label, runId: x.run.id });
    filesOut.push({ path: e.path, diffArtifactId: diffA.id, fileArtifactId: fileA.id, added: d.added, removed: d.removed, codeHash: hashFiles({ [e.path]: e.code }, [e.path]) });
  }
  // Record which findings this repair claims to address; verification decides whether they are resolved.
  if (addressed.length) await prisma.missionFinding.updateMany({ where: { missionId: x.m.id, code: { in: addressed } }, data: { addressedByRunId: x.run.id, repairAttempts: { increment: 1 } } });
  const output = { files: filesOut, change: edits.map((e) => e.label).join("; "), addressesFindings: addressed, author: live ? "model-assisted" : "simulated-candidate" };
  return {
    output,
    artifacts: filesOut.flatMap((f) => [f.diffArtifactId, f.fileArtifactId]),
    decisions: [output.change],
    outcome: { status: "SUCCEEDED", verification: "NONE", summary: `Attempt ${x.run.attempt}: ${output.change} (+${filesOut.reduce((n, f) => n + f.added, 0)} −${filesOut.reduce((n, f) => n + f.removed, 0)})${addressed.length ? ` — addresses ${addressed.join(", ")}` : ""}`, outcome: "changed" },
    nextAction: "Run the full test suite on the changed code",
  };
}

async function doTest(x: Exec): Promise<Handled> {
  const repo = x.repo!;
  if (!(await sandboxUp(x))) return sandboxDown(x, "tests were NOT run, so the change is unverified");
  const { res, ev, codeHash } = await runSuite(x, repo, `after fix attempt ${x.m.repairRounds + 1}`);
  const output = { passed: res.failed === 0 && res.total > 0, tests: ev, codeHash };
  if (output.passed) {
    // A QA finding is resolved only by a passing run on the changed code.
    await prisma.missionFinding.updateMany({ where: { missionId: x.m.id, status: "OPEN", source: "qa" }, data: { status: "RESOLVED", resolvedByRunId: x.run.id, resolvedAt: new Date() } });
    return { output, tests: [ev], outcome: { status: "SUCCEEDED", verification: "PASSED", summary: `All ${res.total} tests pass in the Docker sandbox`, outcome: "passed" }, nextAction: "Independent review of the change" };
  }
  // A failing test is a finding raised by QA, with the test report as evidence.
  const code = await nextFindingCode(x.m.id);
  const fixRun = await latestRun(x.m.id, "fix");
  await prisma.missionFinding.create({
    data: {
      missionId: x.m.id, companyId: x.m.companyId, code, source: "qa", taskKey: x.t.key, runId: x.run.id, severity: "HIGH", blocking: true,
      title: `${res.failed}/${res.total} tests fail after the change`, description: `Failing: ${ev.failing.join("; ")}`, file: repo.sourceFiles[0],
      evidence: JSON.stringify({ artifactId: ev.artifactId, case: ev.failing[0] }), supported: true, recommendation: "Fix the failing behaviour without changing the tests.", againstRunId: fixRun?.id,
    },
  });
  await sendMessage({ companyId: x.m.companyId, fromKey: "qa-engineer", toKey: "backend-engineer", type: "BUG_REPORT", severity: "HIGH", message: `Mission "${x.m.title}" ${code}: ${res.failed}/${res.total} tests still fail — ${ev.failing.join("; ")}` });
  return { output, tests: [ev], findings: [`${code}: ${ev.failing.join("; ")}`], outcome: { status: "REPAIR", reason: `${res.failed}/${res.total} tests failed`, findingCodes: [code], summary: `${res.failed}/${res.total} tests failed: ${ev.failing.join("; ")}`, verification: "FAILED", outcome: "tests_failed" } };
}

async function doReview(x: Exec): Promise<Handled> {
  const repo = x.repo!;
  if (!(await sandboxUp(x))) return sandboxDown(x, "review probes could not execute, so the review is unverified");
  const files = await currentFiles(x.m.id, repo);
  const codeHash = hashFiles(files, repo.sourceFiles);
  for (const f of repo.sourceFiles) await tool(x, "code.read", { path: f, reason: "review" }, async () => ({ path: f, bytes: files[f].length, lines: files[f].split("\n").length }));
  const { obj } = await callModel(x, `Review the change for: ${x.m.title}`);
  x.claims.push(String(obj.summary ?? "").slice(0, 600));
  const raw = Array.isArray(obj.concerns) ? (obj.concerns as Record<string, unknown>[]) : [];

  // Concerns the model raised + the repo's required probes (deterministic baseline). Every concern is executed.
  const probeIds = new Set<string>(repo.requiredProbes);
  for (const c of raw) if (typeof c.probe === "string") probeIds.add(c.probe);
  const checks: { probe: string; description: string; pass: boolean }[] = [];
  const raised: string[] = [];
  let unsupported = 0;
  const fixRun = await latestRun(x.m.id, "fix");
  for (const id of probeIds) {
    const probe = repo.probes.find((p) => p.id === id);
    const concern = raw.find((c) => c.probe === id);
    if (!probe) {
      // A concern that names no executable probe cannot be checked → recorded once, never blocking.
      unsupported++;
      if (await prisma.missionFinding.findFirst({ where: { missionId: x.m.id, status: "UNSUPPORTED", evidence: { contains: `"probe":"${id}"` } } })) continue;
      const code = await nextFindingCode(x.m.id);
      await prisma.missionFinding.create({ data: { missionId: x.m.id, companyId: x.m.companyId, code, source: "reviewer", taskKey: x.t.key, runId: x.run.id, severity: "LOW", blocking: false, title: String(concern?.title ?? id).slice(0, 160), description: `Unsupported: no executable evidence. ${String(concern?.rationale ?? "")}`.slice(0, 800), evidence: JSON.stringify({ probe: id }), supported: false, status: "UNSUPPORTED", againstRunId: fixRun?.id } });
      continue;
    }
    const result = await runProbe(x, repo, probe);
    checks.push({ probe: id, description: probe.description, pass: result.pass });
    if (result.pass) {
      // A passing probe that an earlier finding was about is a resolution, not a new unsupported claim.
      const prior = await prisma.missionFinding.findFirst({ where: { missionId: x.m.id, source: "reviewer", evidence: { contains: `"probe":"${id}"` } } });
      if (concern && !prior) {
        // The model claimed a problem the probe disproves: an unsupported finding, kept for the record.
        unsupported++;
        const code = await nextFindingCode(x.m.id);
        await prisma.missionFinding.create({ data: { missionId: x.m.id, companyId: x.m.companyId, code, source: "reviewer", taskKey: x.t.key, runId: x.run.id, severity: "LOW", blocking: false, title: String(concern.title ?? probe.description).slice(0, 160), description: `Unsupported: probe "${id}" passed on the current code, so this concern is not reproduced.`, file: probe.file, evidence: JSON.stringify({ artifactId: result.artifactId, probe: id, codeHash }), supported: false, status: "UNSUPPORTED", againstRunId: fixRun?.id } });
      }
      continue;
    }
    // Probe failed → a supported finding (dedupe against an identical open finding).
    const existing = await prisma.missionFinding.findFirst({ where: { missionId: x.m.id, status: "OPEN", source: "reviewer", evidence: { contains: `"probe":"${id}"` } } });
    if (existing) {
      raised.push(existing.code);
      continue;
    }
    const draft = FindingDraftSchema.safeParse({
      severity: (concern?.severity as string) ?? "HIGH",
      blocking: concern ? concern.blocking !== false : true,
      title: String(concern?.title ?? `${probe.description} — fails`).slice(0, 160),
      description: `Probe "${id}" failed on the changed code: ${probe.description.toLowerCase()} is not enforced.`,
      file: probe.file,
      recommendation: "Make the check type-safe (e.g. Number.isInteger) rather than a range comparison.",
      evidence: { artifactId: result.artifactId, probe: id, codeHash },
    });
    if (!draft.success) continue;
    const code = await nextFindingCode(x.m.id);
    await prisma.missionFinding.create({ data: { missionId: x.m.id, companyId: x.m.companyId, code, source: "reviewer", taskKey: x.t.key, runId: x.run.id, severity: draft.data.severity, blocking: draft.data.blocking, title: draft.data.title, description: draft.data.description, file: draft.data.file, evidence: JSON.stringify(draft.data.evidence), supported: true, recommendation: draft.data.recommendation, againstRunId: fixRun?.id } });
    raised.push(code);
  }

  // Findings previously addressed by a repair are resolved only if their probe now passes on this exact code.
  const addressed = await prisma.missionFinding.findMany({ where: { missionId: x.m.id, status: "OPEN", source: "reviewer", NOT: { code: { in: raised } } } });
  for (const f of addressed) {
    const ev = parseJSON<{ probe?: string }>(f.evidence, {});
    const c = checks.find((k) => k.probe === ev.probe);
    if (c?.pass) await prisma.missionFinding.update({ where: { id: f.id }, data: { status: "RESOLVED", resolvedByRunId: x.run.id, resolvedAt: new Date() } });
  }

  const blocking = await prisma.missionFinding.findMany({ where: { missionId: x.m.id, status: "OPEN", blocking: true } });
  const output = { verdict: blocking.length ? "changes_requested" : "approve", codeHash, checks, findings: raised, unsupportedClaims: unsupported };
  if (blocking.length) {
    await sendMessage({ companyId: x.m.companyId, fromKey: "reviewer", toKey: "backend-engineer", type: "BUG_REPORT", severity: "HIGH", message: `Mission "${x.m.title}": changes requested — ${blocking.map((f) => `${f.code} ${f.title}`).join("; ")}` });
    return { output, findings: blocking.map((f) => `${f.code} [${f.severity}] ${f.title}`), outcome: { status: "REPAIR", reason: `${blocking.length} blocking finding(s)`, findingCodes: blocking.map((f) => f.code), summary: `Changes requested: ${blocking.map((f) => `${f.code} ${f.title}`).join("; ")}${unsupported ? ` (${unsupported} unsupported concern(s) recorded, not blocking)` : ""}`, verification: "FAILED", outcome: "changes_requested" } };
  }
  return { output, outcome: { status: "SUCCEEDED", verification: "PASSED", summary: `Approved: ${checks.length} probe(s) executed, all pass${unsupported ? `; ${unsupported} unsupported concern(s) recorded, not blocking` : ""}`, outcome: "approved" }, nextAction: "Proceed to the next gate" };
}

async function doSecurityReview(x: Exec): Promise<Handled> {
  const repo = x.repo!;
  const files = await currentFiles(x.m.id, repo);
  const codeHash = hashFiles(files, repo.sourceFiles);
  // Deterministic checks over the actual code — a model opinion alone is not evidence. No model call needed.
  const checks = await tool(x, "security.scan", { paths: repo.sourceFiles }, async () => repo.securityChecks(files), undefined);
  const failed = checks.filter((c) => !c.pass);
  const a = await addArtifact(x.m, x.t.key, "SECURITY_REPORT", "Security review", checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.check}`).join("\n"), { checks, codeHash, runId: x.run.id });
  const codes: string[] = [];
  for (const f of failed) {
    const code = await nextFindingCode(x.m.id);
    await prisma.missionFinding.create({ data: { missionId: x.m.id, companyId: x.m.companyId, code, source: "security", taskKey: x.t.key, runId: x.run.id, severity: "HIGH", blocking: true, title: f.check, description: `Deterministic security check failed on the final code: ${f.check}`, file: repo.sourceFiles[0], evidence: JSON.stringify({ artifactId: a.id, codeHash }), supported: true } });
    codes.push(code);
  }
  const output = { codeHash, checks, findings: codes };
  if (failed.length) return { output, outcome: { status: "FAILED", category: "security_policy_violation", error: `Security issues: ${failed.map((c) => c.check).join("; ")}`, verification: "FAILED", retryable: false, outcome: "failed_checks" } };
  return { output, artifacts: [a.id], outcome: { status: "SUCCEEDED", verification: "PASSED", summary: `${checks.length} security checks passed on the final code`, outcome: "passed" } };
}

async function doApproval(x: Exec): Promise<Handled> {
  const repo = x.repo!;
  const files = await currentFiles(x.m.id, repo);
  const hash = hashFiles(files, repo.sourceFiles);
  const diffs = await prisma.missionArtifact.findMany({ where: { missionId: x.m.id, kind: "DIFF" }, orderBy: { createdAt: "asc" } });
  const lastDiff = diffs[diffs.length - 1];
  const dm = parseJSON<{ added?: number; removed?: number }>(lastDiff?.meta, {});
  const a = await prisma.missionApproval.create({
    data: {
      missionId: x.m.id,
      companyId: x.m.companyId,
      taskKey: x.t.key,
      action: `Mark the change to ${repo.sourceFiles.join(", ")} as ready to release`,
      reason: "The change is customer-facing; a human must review the tested and reviewed diff.",
      impact: lastDiff ? `${dm.added ?? 0} lines added, ${dm.removed ?? 0} removed in ${repo.sourceFiles.length} file(s)` : `${repo.sourceFiles.length} file(s)`,
      risk: x.m.risk,
      onApprove: "The change is recorded as approved and ready to release. AURA does not deploy it.",
      onReject: "The mission fails with the change unapproved; the original code is unaffected.",
      payloadHash: hash,
      expiresAt: new Date(Date.now() + 7 * 864e5),
    },
  });
  await event(x.m.companyId, x.m.id, "Approval requested: release-ready change", "warning", x.t.agentKey, { analytics: "approval_requested" });
  return { output: { approvalId: a.id, payloadHash: hash }, outcome: { status: "WAITING_APPROVAL", summary: "Waiting for a human decision" }, nextAction: "A human approves or rejects the change" };
}

async function doReport(x: Exec): Promise<Handled> {
  const { obj } = await callModel(x, `Write the mission report for: ${x.m.title}`);
  // Unresolved items come from persisted state, not from the model.
  const open = await prisma.missionFinding.findMany({ where: { missionId: x.m.id, status: { in: ["OPEN", "UNRESOLVED"] } } });
  const unsupported = await prisma.missionFinding.count({ where: { missionId: x.m.id, status: "UNSUPPORTED" } });
  const unresolved = [...open.map((f) => `${f.code} ${f.title}`), ...(unsupported ? [`${unsupported} reviewer concern(s) were not supported by evidence and were not acted on`] : [])];
  x.claims.push(String(obj.summary ?? "").slice(0, 1200));
  return { output: { summary: String(obj.summary ?? "Report"), unresolved }, outcome: { status: "SUCCEEDED", verification: "NONE", summary: "Report written", outcome: "report" } };
}

async function doAnalysis(x: Exec): Promise<Handled> {
  const { obj } = await callModel(x, x.t.title);
  await addArtifact(x.m, x.t.key, "ANALYSIS", x.t.title, JSON.stringify(obj, null, 2), { mode: [...x.usage.modes].join(","), runId: x.run.id });
  return { output: obj, outcome: { status: "SUCCEEDED", verification: "NONE", summary: String(obj.summary ?? "Analysis recorded").slice(0, 200), outcome: "analysis" } };
}

function sandboxDown(_x: Exec, what: string): Handled {
  return { output: {}, outcome: { status: "FAILED", category: "sandbox_failure", error: `Docker sandbox unavailable — ${what}. Start Docker and retry.`, verification: "UNVERIFIED", retryable: false, outcome: "unverified" } };
}

/** Deterministic steps (no model call) still need an AgentRun to attach ToolCall audit rows to. */
async function ensureToolRun(x: Exec): Promise<string> {
  const agent = await prisma.agent.findUnique({ where: { companyId_key: { companyId: x.m.companyId, key: x.t.agentKey } } });
  if (!agent) throw new Error(`Agent ${x.t.agentKey} not provisioned in this workspace`);
  const r = await prisma.agentRun.create({ data: { companyId: x.m.companyId, agentId: agent.id, objective: `${x.t.title} (deterministic step)`, model: "none", tier: "NONE", status: "COMPLETED", summary: "Deterministic tool step — no model call", promptRef: "none", usageSource: "provider" } });
  x.usage.runIds.push(r.id);
  return r.id;
}

async function latestRun(missionId: string, taskKey: string) {
  return prisma.missionTaskRun.findFirst({ where: { missionId, taskKey, status: "SUCCEEDED" }, orderBy: { startedAt: "desc" } });
}

const HANDLERS: Record<string, (x: Exec) => Promise<Handled>> = {
  REQUIREMENTS: doRequirements,
  ARCHITECTURE: doArchitecture,
  ANALYSIS: doAnalysis,
  REPRODUCE: doReproduce,
  CODE_CHANGE: doCodeChange,
  TEST: doTest,
  REVIEW: doReview,
  SECURITY_REVIEW: doSecurityReview,
  APPROVAL: doApproval,
  REPORT: doReport,
};

const NEEDS_REPO = new Set(["ARCHITECTURE", "REPRODUCE", "CODE_CHANGE", "TEST", "REVIEW", "SECURITY_REVIEW", "APPROVAL"]);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  run: Run;
  outcome: Outcome;
}

/** Classify an exception thrown during execution. */
function classify(e: unknown): { category: string; retryable: boolean } {
  if (e instanceof CancelledError) return { category: "cancelled", retryable: false };
  if (e instanceof PermissionError) return { category: "authorization_denied", retryable: false };
  if (e instanceof ToolError) return { category: e.category, retryable: ["tool_timeout", "tool_execution_error"].includes(e.category) };
  if (e instanceof BudgetExceededError || e instanceof TaskBudgetError) return { category: "budget_exceeded", retryable: false };
  if (e instanceof PolicyRefusalError) return { category: "security_policy_violation", retryable: false };
  if (e instanceof InvalidOutputError) return { category: "invalid_structured_output", retryable: true };
  if (e instanceof RefusalError) return { category: "model_refusal", retryable: false };
  if (e instanceof ContextOverflowError) return { category: "context_overflow", retryable: false };
  if (e instanceof MissingContextError) return { category: "agent_handoff_failure", retryable: false };
  return { category: "tool_execution_error", retryable: false };
}

/**
 * Execute one attempt of a task. Never throws for task-level failures: the
 * outcome (with category) is returned and the run row records everything.
 */
export async function executeTaskRun(m: Mission, t: Task, worker: string): Promise<ExecutionResult> {
  const attempt = (await prisma.missionTaskRun.count({ where: { missionId: m.id, taskKey: t.key } })) + 1;
  const runRow = await prisma.missionTaskRun.create({ data: { missionId: m.id, companyId: m.companyId, taskId: t.id, taskKey: t.key, attempt, agentKey: t.agentKey, worker } });
  const x: Exec = {
    m, t, run: runRow, ctx: { text: "", tokens: 0, budget: 0, sources: [], notes: [], missingRequired: [], handoffs: [] }, repo: repoFor(m.template),
    usage: { modelCalls: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latencyMs: 0, estimated: false, modes: new Set(), models: new Set(), tier: "", runIds: [] },
    toolLog: [],
    claims: [],
  };
  const started = Date.now();
  const cap = capabilityFor(t.agentKey);
  let handled: Handled | null = null;
  let outcome: Outcome;
  let validation: { ok: boolean; errors: string[] } = { ok: false, errors: [] };
  let retries = 0;

  try {
    if (NEEDS_REPO.has(t.kind) && !x.repo) throw new MissingContextError(["code (no executable codebase is attached to this mission)"]);
    x.ctx = await assembleContext(m, t);
    if (x.ctx.missingRequired.length) throw new MissingContextError(x.ctx.missingRequired);
    const handler = HANDLERS[t.kind];
    if (!handler) throw new MissingContextError([`no executor for task kind ${t.kind}`]);

    // In-execution retry for transient failures, per the agent's retry policy.
    const maxTries = Math.max(1, t.maxAttempts);
    for (let i = 0; ; i++) {
      try {
        handled = await handler(x);
        break;
      } catch (e) {
        const c = classify(e);
        const allowed = (cap?.retry.retryOn as readonly string[] | undefined)?.includes(c.category) ?? false;
        if (!c.retryable || !allowed || i + 1 >= maxTries) throw e;
        retries++;
        x.toolLog.push({ tool: "(retry)", status: "retrying", durationMs: 0, error: `${c.category}: ${(e as Error).message.slice(0, 200)}` });
        await event(m.companyId, m.id, `${t.title}: retrying after ${c.category}`, "warning", t.agentKey);
      }
    }
    // Validate the structured output against the kind contract before anyone consumes it.
    if (handled.outcome.status === "FAILED" && Object.keys(handled.output).length === 0) validation = { ok: false, errors: ["no output (task failed)"] };
    else {
      const v = validateOutput(t.kind, handled.output);
      validation = v.ok ? { ok: true, errors: [] } : { ok: false, errors: v.errors };
      if (v.ok) handled.output = v.value as Record<string, unknown>;
    }
    if (!validation.ok && handled.outcome.status !== "FAILED") throw new InvalidOutputError(validation.errors, JSON.stringify(handled.output).slice(0, 500));
    outcome = handled.outcome;
  } catch (e) {
    const c = classify(e);
    outcome = { status: "FAILED", category: c.category, error: (e as Error).message.slice(0, 1000), retryable: false, verification: c.category === "sandbox_failure" ? "UNVERIFIED" : "NONE" };
    if (e instanceof InvalidOutputError) validation = { ok: false, errors: e.errors };
  }

  // Test hook: e.g. cancel the mission while this step is "executing".
  const hook = takeFault(m.id, t.key, "afterExecute");
  if (hook) await hook.fn();

  // Persist the handoff (only for valid, successful-or-repair outputs).
  if (handled && validation.ok && (outcome.status === "SUCCEEDED" || outcome.status === "WAITING_APPROVAL" || outcome.status === "REPAIR")) {
    const tasks = await prisma.missionTask.findMany({ where: { missionId: m.id, planVersion: m.planVersion } });
    const dependents = tasks.filter((d) => parseJSON<string[]>(d.dependsOn, []).includes(t.key));
    const openIssues = await prisma.missionFinding.findMany({ where: { missionId: m.id, status: "OPEN" }, orderBy: { createdAt: "asc" } });
    const arts = handled.artifacts?.length ? await prisma.missionArtifact.findMany({ where: { id: { in: handled.artifacts }, missionId: m.id } }) : [];
    const payload: Handoff = {
      missionId: m.id,
      taskKey: t.key,
      taskKind: t.kind,
      runId: runRow.id,
      fromAgent: t.agentKey,
      toAgents: [...new Set(dependents.map((d) => d.agentKey))],
      objective: t.title,
      findings: handled.findings ?? [],
      decisions: (handled.decisions ?? []).filter(Boolean),
      artifacts: arts.map((a) => ({ id: a.id, kind: a.kind, name: a.name, version: a.version })),
      tests: handled.tests ?? [],
      outstandingIssues: openIssues.map((f) => ({ code: f.code, severity: f.severity, blocking: f.blocking, title: f.title })),
      risks: Array.isArray(handled.output.risks) ? (handled.output.risks as string[]).slice(0, 10) : [],
      nextAction: handled.nextAction ?? (outcome.status === "REPAIR" ? "Repair the change to resolve the open findings" : "Continue with dependent tasks"),
      output: handled.output,
      claims: x.claims.join("\n").slice(0, 2000),
    };
    const hv = validateHandoff(payload);
    await prisma.missionHandoff.create({ data: { missionId: m.id, companyId: m.companyId, planVersion: m.planVersion, fromTaskKey: t.key, fromAgent: t.agentKey, toAgents: JSON.stringify(payload.toAgents), runId: runRow.id, payload: JSON.stringify(payload), valid: hv.ok, errors: JSON.stringify(hv.ok ? [] : hv.errors) } });
    if (!hv.ok) outcome = { status: "FAILED", category: "agent_handoff_failure", error: `Handoff failed validation: ${hv.errors.join("; ")}`, retryable: false };
  }

  const mode = x.usage.modes.size === 0 ? "none" : x.usage.modes.size > 1 ? "mixed" : [...x.usage.modes][0];
  const statusOf = outcome.status === "FAILED" ? "FAILED" : "SUCCEEDED";
  const updated = await prisma.missionTaskRun.update({
    where: { id: runRow.id },
    data: {
      status: statusOf,
      outcome: outcome.status === "FAILED" ? outcome.outcome ?? outcome.category : outcome.status === "WAITING_APPROVAL" ? "approval_requested" : outcome.outcome,
      tier: x.usage.tier || cap?.tier || "",
      model: [...x.usage.models].join(", "),
      mode,
      routingReason: cap ? `capability tier ${cap.tier} for ${t.agentKey}${x.usage.models.size ? "" : " (no model call)"}` : "",
      modelCalls: x.usage.modelCalls,
      toolCalls: x.usage.toolCalls,
      retries,
      tokensIn: x.usage.tokensIn,
      tokensOut: x.usage.tokensOut,
      cacheReadTokens: x.usage.cacheRead,
      cacheWriteTokens: x.usage.cacheWrite,
      usageEstimated: x.usage.estimated,
      costUsd: x.usage.cost,
      latencyMs: Date.now() - started,
      contextSources: JSON.stringify(x.ctx.sources),
      contextTokens: x.ctx.tokens,
      contextNotes: JSON.stringify(x.ctx.notes),
      output: JSON.stringify(handled?.output ?? {}),
      outputValid: validation.ok,
      validationErrors: JSON.stringify(validation.errors),
      claims: x.claims.join("\n").slice(0, 4000),
      errorCategory: outcome.status === "FAILED" ? outcome.category : null,
      error: outcome.status === "FAILED" ? outcome.error : "",
      agentRunIds: JSON.stringify(x.usage.runIds),
      toolLog: JSON.stringify(x.toolLog),
      completedAt: new Date(),
    },
  });
  return { run: updated, outcome };
}
