/**
 * Runs benchmarks against AURA's REAL engineering pipeline components — the
 * same functions the builder engine (src/lib/builder/engine.ts) calls:
 *
 *   verificationPlan → executed commands → buildIndex → analyzeChange →
 *   gateVerdict (verdict.ts), contextFiles (context selection),
 *   classify / signatureOf (debugging), recoverOrphanedBuilds (recovery)
 *
 * What is NOT exercised: the model. Benchmarks supply the candidate change a
 * coding agent might produce, so the lab measures AURA's own engineering
 * methods (verification, context, diagnosis, impact, recovery)
 * deterministically and reproducibly. Model-quality evaluation is separate
 * (src/lib/intelligence) and needs a live provider key.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { verificationPlan, parseTestSummary } from "@/lib/builder/detect";
import { buildIndex, analyzeChange, contextFiles, isTestFile, type Impact } from "@/lib/builder/intel";
import { gateVerdict, GATE_POLICIES } from "@/lib/builder/verdict";
import { classify, signatureOf } from "@/lib/builder/debug";
import { recoverOrphanedBuilds } from "@/lib/builder/service";
import { runInFixture, type ExecutorKind, type ExecOutcome } from "./executor";
import type { Benchmark } from "./benchmarks";
import type { LabConfig } from "./config";

export interface CaseOutcome {
  benchmarkId: string;
  benchmarkVersion: number;
  category: string;
  split: string;
  kind: string;
  fixtureHash: string;
  status: "PASSED" | "FAILED" | "ERROR" | "SKIPPED";
  criteria: { id: string; text: string; passed: boolean; evidence: string }[];
  measures: Record<string, number | string | boolean | string[] | null>;
  commands: { command: string; exitCode: number | null; durationMs: number; outputTail: string }[];
  error: string;
  durationMs: number;
  sandboxMs: number;
}

export const hashFiles = (f: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(Object.entries(f).sort(([a], [b]) => a.localeCompare(b)))).digest("hex").slice(0, 16);

function apply(base: Record<string, string>, change: Record<string, string | null> = {}) {
  const out = { ...base };
  for (const [p, c] of Object.entries(change)) {
    if (c === null) delete out[p];
    else out[p] = c;
  }
  return out;
}

function diffList(base: Record<string, string>, change: Record<string, string | null> = {}) {
  return Object.entries(change).map(([path, c]) => ({ status: c === null ? "D" : base[path] === undefined ? "A" : "M", path }));
}

/** Run the project's verification plan exactly as the engine does (test/lint/typecheck/build/check; no installs). */
async function verify(kind: ExecutorKind, files: Record<string, string>) {
  const plan = verificationPlan(files);
  const results: { id: string; command: string; ok: boolean; exitCode: number | null; output: string; timedOut: boolean; durationMs: number }[] = [];
  for (const c of plan.checks.filter((x) => x.id === "test")) {
    const r = await runInFixture(kind, files, c.command);
    results.push({ id: c.id, command: c.command, ok: r.exitCode === 0 && !r.timedOut, exitCode: r.exitCode, output: r.output, timedOut: r.timedOut, durationMs: r.durationMs });
  }
  const hasTest = results.some((r) => r.id === "test");
  return { results, hasTest, passed: hasTest && results.every((r) => r.ok), notes: plan.notes };
}

const tail = (r: ExecOutcome | { command: string; exitCode: number | null; output: string; durationMs: number }) => ({ command: r.command, exitCode: r.exitCode, durationMs: r.durationMs, outputTail: r.output.slice(-1200) });

export async function runBenchmark(b: Benchmark, cfg: LabConfig, executor: ExecutorKind, ctx: { companyId: string }): Promise<CaseOutcome> {
  const started = Date.now();
  const base: CaseOutcome = { benchmarkId: b.id, benchmarkVersion: b.version, category: b.category, split: b.split, kind: b.kind, fixtureHash: hashFiles({ base: b.base, change: b.change ?? {} }), status: "ERROR", criteria: [], measures: {}, commands: [], error: "", durationMs: 0, sandboxMs: 0 };
  try {
    const out = await runKind(b, cfg, executor, ctx);
    return { ...base, ...out, status: out.criteria.every((c) => c.passed) ? "PASSED" : "FAILED", durationMs: Date.now() - started };
  } catch (e) {
    return { ...base, status: "ERROR", error: (e as Error).message.slice(0, 1000), durationMs: Date.now() - started };
  }
}

async function runKind(b: Benchmark, cfg: LabConfig, executor: ExecutorKind, ctx: { companyId: string }): Promise<Pick<CaseOutcome, "criteria" | "measures" | "commands" | "sandboxMs">> {
  const crit = (id: string, passed: boolean, evidence: string) => ({ id, text: b.criteria.find((c) => c.id === id)?.text ?? id, passed, evidence: evidence.slice(0, 600) });

  if (b.kind === "gate") {
    const after = apply(b.base, b.change);
    const ver = await verify(executor, after);
    const [ib, ia] = await Promise.all([buildIndex(b.base), buildIndex(after)]);
    const changed = diffList(b.base, b.change);
    const protectedTests = ib.files.filter((f) => isTestFile(f.path)).map((f) => f.path);
    const impact: Impact = analyzeChange({ before: ib, after: ia, beforeFiles: b.base, afterFiles: after, changed, protectedTests, scope: [] });
    const policy = GATE_POLICIES[cfg.gatePolicy];
    if (!policy) throw new Error(`unknown gate policy ${cfg.gatePolicy}`);
    const v = gateVerdict(policy, { results: ver.results, hasTest: ver.hasTest, impact, task: b.task, beforeFiles: b.base, afterFiles: after });
    const decision = v.accept ? "accept" : "reject";
    const t = ver.results[0] ? parseTestSummary(ver.results[0].output) : null;
    const criteria = b.criteria.map((c) => {
      if (c.id === "tests-pass") return crit(c.id, ver.passed, ver.results.map((r) => `${r.command} → exit ${r.exitCode}`).join("; ") || "no test command");
      return crit(c.id, decision === b.expect.decision, `gate ${policy.id} decided ${decision}${v.reasons.length ? ` (${v.reasons.map((r) => r.code).join(", ")})` : ""}; expected ${b.expect.decision}${b.expect.rejectBecause ? ` — ${b.expect.rejectBecause}` : ""}`);
    });
    return {
      criteria,
      measures: { expected: b.expect.decision ?? null, decision, falseAccept: b.expect.decision === "reject" && decision === "accept", falseReject: b.expect.decision === "accept" && decision === "reject", testsPassed: ver.passed, tests: t?.tests ?? null, testsFailed: t?.fail ?? null, reasons: v.reasons.map((r) => r.code), flags: impact.flags.map((f) => `${f.confidence}:${f.kind}`), selectedTests: impact.tests },
      commands: ver.results.map(tail),
      sandboxMs: ver.results.reduce((s, r) => s + r.durationMs, 0),
    };
  }

  if (b.kind === "context") {
    const ix = await buildIndex(b.base);
    const picked = contextFiles(ix, b.task, cfg.contextStrategy);
    const want = b.expect.files ?? [];
    const hit = want.filter((f) => picked.files.includes(f));
    const precision = picked.files.length ? picked.files.filter((f) => want.includes(f)).length / picked.files.length : 0;
    const contextChars = picked.files.reduce((s, f) => s + (b.base[f]?.length ?? 0), 0);
    return {
      criteria: [crit("files", hit.length === want.length, `selected ${picked.files.join(", ") || "nothing"} (${picked.strategy}); expected ${want.join(", ")}`)],
      measures: { recall: want.length ? hit.length / want.length : null, precision, selected: picked.files, contextChars, strategy: picked.strategy },
      commands: [],
      sandboxMs: 0,
    };
  }

  if (b.kind === "diagnose") {
    const plan = verificationPlan(b.base);
    const testCheck = plan.checks.find((c) => c.id === "test");
    // Same path as the engine: without a test script nothing is executed; the engine reports a
    // blocking "No test command" finding, which is a configuration problem.
    if (!testCheck) {
      const criteria = b.criteria.map((c) => c.id === "category" ? crit(c.id, b.expect.category === "configuration", `no test command; engine reports a configuration finding: ${plan.notes.join(" ")}`) : crit(c.id, !(b.expect.failingTests ?? []).length, "no tests ran"));
      return { criteria, measures: { category: "configuration", expected: b.expect.category ?? null, failingTests: [], exitCode: null }, commands: [], sandboxMs: 0 };
    }
    const command = testCheck.command;
    const r = await runInFixture(executor, b.base, command);
    const cr = { id: "test", command, ok: r.exitCode === 0 && !r.timedOut, exitCode: r.exitCode, commandRunId: "lab", output: r.output, timedOut: r.timedOut };
    const cls = classify(cr, cfg.classifier);
    const sig = signatureOf(cr);
    const criteria = b.criteria.map((c) => c.id === "category" ? crit(c.id, cls.category === b.expect.category, `classified ${cls.category} (${cls.reason}); expected ${b.expect.category}; exit ${r.exitCode}`) : crit(c.id, (b.expect.failingTests ?? []).every((t) => sig.failingTests.includes(t)), `failing tests found: ${sig.failingTests.join("; ") || "none"}`));
    return { criteria, measures: { category: cls.category, expected: b.expect.category ?? null, failingTests: sig.failingTests, exitCode: r.exitCode }, commands: [tail(r)], sandboxMs: r.durationMs };
  }

  if (b.kind === "impact") {
    const after = apply(b.base, b.change);
    const [ib, ia] = await Promise.all([buildIndex(b.base), buildIndex(after)]);
    const imp = analyzeChange({ before: ib, after: ia, beforeFiles: b.base, afterFiles: after, changed: diffList(b.base, b.change), protectedTests: ib.files.filter((f) => isTestFile(f.path)).map((f) => f.path) });
    const kinds = imp.flags.map((f) => f.kind);
    const testsOk = (b.expect.tests ?? []).every((t) => imp.tests.includes(t));
    const flagsOk = (b.expect.flags ?? []).every((f) => kinds.includes(f as never)) && (b.expect.noFlags ?? []).every((f) => !kinds.includes(f as never));
    const criteria = b.criteria.map((c) => c.id === "tests" ? crit(c.id, testsOk, `selected tests: ${imp.tests.join(", ") || "none"}`) : crit(c.id, flagsOk, `flags: ${kinds.join(", ") || "none"}`));
    return { criteria, measures: { selectedTests: imp.tests, flags: kinds, dependents: imp.dependents }, commands: [], sandboxMs: 0 };
  }

  if (b.kind === "recover") {
    // Real service + real queue rows in the lab's own workspace; cleaned up afterwards.
    const productId = `lab-recover-${Date.now()}`;
    const deadJob = await prisma.job.create({ data: { companyId: ctx.companyId, type: "build.run", payload: "{}", status: "DEAD", lastError: "worker crashed (lab)", createdBy: "lab", correlationId: "lab" } });
    const liveJob = await prisma.job.create({ data: { companyId: ctx.companyId, type: "build.run", payload: "{}", status: "RUNNING", leaseUntil: new Date(Date.now() + 60_000), createdBy: "lab", correlationId: "lab" } });
    const orphan = await prisma.build.create({ data: { companyId: ctx.companyId, productId, itemKey: "LAB.T1", branch: "aura/lab", status: "RUNNING", phase: "verify", jobId: deadJob.id, correlationId: "lab", createdBy: "lab" } });
    const live = await prisma.build.create({ data: { companyId: ctx.companyId, productId, itemKey: "LAB.T2", branch: "aura/lab2", status: "RUNNING", phase: "implement", jobId: liveJob.id, correlationId: "lab", createdBy: "lab" } });
    try {
      const recovered = await recoverOrphanedBuilds(ctx.companyId, productId);
      const o = await prisma.build.findUnique({ where: { id: orphan.id } });
      const l = await prisma.build.findUnique({ where: { id: live.id } });
      return {
        criteria: [crit("blocked", o?.status === "BLOCKED" && /Recovered after an interruption/.test(o.failure), `orphan → ${o?.status}: ${o?.failure.slice(0, 160)}`), crit("live-untouched", l?.status === "RUNNING" && !recovered.includes(live.id), `live run → ${l?.status}`)],
        measures: { recovered: recovered.length },
        commands: [],
        sandboxMs: 0,
      };
    } finally {
      await prisma.build.deleteMany({ where: { id: { in: [orphan.id, live.id] } } });
      await prisma.job.deleteMany({ where: { id: { in: [deadJob.id, liveJob.id] } } });
    }
  }
  throw new Error(`unknown benchmark kind ${b.kind}`);
}
