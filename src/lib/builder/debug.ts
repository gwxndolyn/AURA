/**
 * Evidence-driven debugging for engineering runs.
 *
 * A failed engine check becomes a Defect: the exact command, exit code and
 * CommandRun (output) are referenced; the failure is classified from the
 * output (code / test assumption / dependency / configuration /
 * infrastructure / permissions / timeout) by deterministic rules, and a stable
 * signature (failing test names, or the normalised first error lines) lets
 * AURA recognise the SAME failure across repair attempts.
 *
 *  - same signature twice in a row after a repair  → RECURRING; the run stops
 *    (repeating the same fix is not progress), even if repairs remain
 *  - a check that failed and now passes            → FIXED, with the passing
 *    CommandRun as proof; a verified solution is written to project memory
 *  - infrastructure / permissions failures are not code defects: the engineer
 *    is not asked to "fix" them
 *
 * The diagnosis given to the engineer is built from recorded evidence only —
 * failing tests, the error excerpt, implicated files (stack frames + the test
 * files' imports) and prior VERIFIED solutions for the same signature.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { parseTestSummary } from "./detect";

export const DEFECT_CATEGORIES = ["code", "test_assumption", "dependency", "configuration", "infrastructure", "permissions", "timeout", "unknown"] as const;
export type DefectCategory = (typeof DEFECT_CATEGORIES)[number];

export interface CheckResult { id: string; command: string; ok: boolean; exitCode: number | null; commandRunId: string; output: string; timedOut?: boolean }

/** Versioned classifier rule sets (evaluated in src/lib/lab before becoming the default). */
export const CLASSIFIER_VERSIONS = ["v1", "v2", "v3"] as const;
// v2 was accepted on host execution (Node 24) only; v3 adopted 2026-10-23 from lab experiment "diagnose-v3" on the Docker sandbox (diagnosisCorrect train 0.75 → 1, held-out 0.67 → 1).
export const DEFAULT_CLASSIFIER = "v3";

/** Classify a failed check from its output (deterministic rules, first match wins). */
export function classify(c: CheckResult, version: string = process.env.AURA_CLASSIFIER || DEFAULT_CLASSIFIER): { category: DefectCategory; reason: string } {
  const o = c.output;
  if (c.timedOut) return { category: "timeout", reason: "the command exceeded its time limit (possible hang, open handle or infinite loop)" };
  // The test runner's own per-test timeout (node:test "test timed out after", jest "Exceeded timeout").
  // v3: Node 20's runner reports a never-settling test as cancelled ("Promise resolution is still pending…",
  // failureType cancelledByParent, "# cancelled N" with "# fail 0") instead of a timeout message.
  if (version === "v3" && /Promise resolution is still pending but the event loop has already resolved|failureType: '?cancelledByParent|^[#ℹ] cancelled [1-9]/m.test(o) && !/^[#ℹ] fail [1-9]/m.test(o)) return { category: "timeout", reason: "a test never settled (unresolved promise, hang or open handle); the runner cancelled it" };
  if (version !== "v1" && /test timed out after \d+ ?ms|Exceeded timeout of \d+ ?ms|Timeout of \d+ms exceeded/i.test(o)) return { category: "timeout", reason: "a test exceeded its time limit (hang, unresolved promise or open handle)" };
  if (/EACCES|EPERM|permission denied|operation not permitted/i.test(o)) return { category: "permissions", reason: "the process was denied filesystem or system access in the sandbox" };
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED registry|network request to .* failed|getaddrinfo/i.test(o) && c.id === "install") return { category: "infrastructure", reason: "the package registry could not be reached" };
  if (/ENOSPC|out of memory|JavaScript heap out of memory|Killed\b/i.test(o)) return { category: "infrastructure", reason: "the sandbox ran out of disk or memory" };
  if (c.id === "install" || /ERESOLVE|ETARGET|No matching version|npm ERR! code E404|Cannot find module '(?![./])[^']+'|ERR_MODULE_NOT_FOUND.*node_modules|Cannot find package/i.test(o)) return { category: "dependency", reason: "a dependency is missing, unresolvable or fails to install" };
  if (/Missing script|SyntaxError: Unexpected token .* in JSON|tsconfig|Cannot find module '\.{1,2}\/[^']+'|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|must use import to load ES Module|is not a valid package\.json/i.test(o)) return { category: "configuration", reason: "project configuration (scripts, module format, paths) is inconsistent" };
  const t = parseTestSummary(o);
  if (c.id === "test" && t.fail === 0 && (t.tests ?? 0) === 0) return { category: "configuration", reason: "the test command ran no tests" };
  if (/TypeError: fetch failed|EADDRINUSE|listen EACCES|ETIMEDOUT/i.test(o)) return { category: "test_assumption", reason: "a test depends on network/ports or timing that the sandbox does not provide" };
  if (/AssertionError|assert\.|Expected|expected .* to|not ok \d+|\bfail\s+[1-9]/i.test(o) || /SyntaxError|ReferenceError|TypeError|RangeError|is not a function|is not defined|error TS\d+/i.test(o)) return { category: "code", reason: "assertions or runtime/type errors in project code" };
  return { category: "unknown", reason: "the output does not match a known failure pattern" };
}

/** Normalise volatile parts (paths, line numbers, durations, ids) so the same failure hashes equally. */
function normalise(line: string) {
  return line
    .replace(/\/(?:work|tmp)\/[^\s:)]+/g, "<path>")
    .replace(/:\d+:\d+/g, ":L")
    .replace(/\b\d+(\.\d+)?\s?m?s\b/g, "<t>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\d+/g, "N")
    .trim();
}

export function errorExcerpt(output: string, max = 12) {
  const lines = output.split("\n");
  const idx = lines.findIndex((l) => /not ok \d+|Error:|AssertionError|error TS\d+|npm ERR!|FAIL\b|✖/.test(l));
  return (idx < 0 ? lines.slice(-max) : lines.slice(idx, idx + max)).join("\n").slice(0, 2000);
}

export function signatureOf(c: CheckResult): { signature: string; failingTests: string[] } {
  const failing = parseTestSummary(c.output).failing;
  const basis = failing.length ? `${c.id}|tests|${[...failing].sort().join("|")}` : `${c.id}|${errorExcerpt(c.output, 6).split("\n").map(normalise).filter(Boolean).join("|")}`;
  return { signature: createHash("sha256").update(basis).digest("hex").slice(0, 24), failingTests: failing };
}

/** Project files named in stack frames or error lines (any absolute or relative path whose suffix is a repo file). */
export function implicatedFiles(output: string, known: string[]) {
  const out = new Set<string>();
  const sorted = [...known].sort((a, b) => b.length - a.length);
  for (const m of output.matchAll(/[\w./-]+\.(?:c|m)?(?:j|t)sx?\b/g)) {
    const tok = m[0];
    const hit = sorted.find((k) => tok === k || tok.endsWith(`/${k}`));
    if (hit) out.add(hit);
  }
  return [...out].slice(0, 12);
}

export interface DefectView { id: string; signature: string; category: DefectCategory; title: string; command: string; exitCode: number | null; commandRunId: string; failingTests: string[]; files: string[]; status: string; occurrences: number; diagnosis: string; fixedBy: string | null }

/**
 * Record the failures of one verification attempt; mark previously open
 * defects whose check now passes as FIXED. Returns the open defects and
 * whether a failure recurred unchanged after a repair attempt.
 */
export async function recordAttempt(args: {
  companyId: string; productId: string; itemKey: string; buildId: string; attempt: number;
  results: CheckResult[]; knownFiles: string[]; testImports: (testFiles: string[]) => string[]; headSha?: string | null;
}) {
  const failed = args.results.filter((r) => !r.ok);
  const seen: DefectView[] = [];
  let recurring: DefectView | null = null;
  for (const r of failed) {
    const { signature, failingTests } = signatureOf(r);
    const cls = classify(r);
    const testFiles = args.knownFiles.filter((f) => failingTests.length && /\.(test|spec)\./.test(f));
    const files = [...new Set([...implicatedFiles(r.output, args.knownFiles), ...args.testImports(testFiles)])].slice(0, 12);
    const title = failingTests.length ? `${failingTests.length} failing test(s): ${failingTests.slice(0, 3).join("; ")}` : `${r.id} failed: ${errorExcerpt(r.output, 1).slice(0, 140) || `exit ${r.exitCode}`}`;
    const diagnosis = `Likely cause: ${cls.category} — ${cls.reason}.`;
    const prior = await prisma.defect.findUnique({ where: { buildId_signature: { buildId: args.buildId, signature } } });
    const row = prior
      ? await prisma.defect.update({ where: { id: prior.id }, data: { occurrences: { increment: prior.lastAttempt === args.attempt ? 0 : 1 }, lastAttempt: args.attempt, status: prior.lastAttempt < args.attempt ? "RECURRING" : prior.status, commandRunId: r.commandRunId, exitCode: r.exitCode, diagnosis } })
      : await prisma.defect.create({ data: { companyId: args.companyId, productId: args.productId, itemKey: args.itemKey, buildId: args.buildId, signature, category: cls.category, title: title.slice(0, 300), command: r.command, exitCode: r.exitCode, commandRunId: r.commandRunId, failingTests: JSON.stringify(failingTests), files: JSON.stringify(files), diagnosis, firstAttempt: args.attempt, lastAttempt: args.attempt } });
    const v = view(row);
    seen.push(v);
    if (prior && prior.lastAttempt === args.attempt - 1) recurring = v;
  }
  // Defects of this run that no longer reproduce: fixed only when their check ran and passed now.
  const open = await prisma.defect.findMany({ where: { buildId: args.buildId, status: { in: ["OPEN", "RECURRING"] }, signature: { notIn: seen.map((s) => s.signature) } } });
  const fixed: DefectView[] = [];
  for (const d of open) {
    const check = args.results.find((r) => r.command === d.command);
    if (!check?.ok) continue;
    const row = await prisma.defect.update({ where: { id: d.id }, data: { status: "FIXED", fixedByCommandRunId: check.commandRunId, fixedSha: args.headSha ?? null } });
    fixed.push(view(row));
  }
  return { open: seen, fixed, recurring };
}

function view(d: { id: string; signature: string; category: string; title: string; command: string; exitCode: number | null; commandRunId: string; failingTests: string; files: string; status: string; occurrences: number; diagnosis: string; fixedByCommandRunId: string | null }): DefectView {
  const { fixedByCommandRunId, ...rest } = d;
  return { ...rest, fixedBy: fixedByCommandRunId, category: d.category as DefectCategory, failingTests: parseJSON<string[]>(d.failingTests, []), files: parseJSON<string[]>(d.files, []) };
}

/** Engineer-facing diagnosis assembled from evidence (no model call). */
export function diagnosisBrief(defects: DefectView[], results: CheckResult[], priorSolutions: { content: string; ref: string }[]) {
  return defects.map((d) => {
    const r = results.find((x) => x.commandRunId === d.commandRunId);
    const sol = priorSolutions.length ? `\nPreviously VERIFIED solution(s) for this failure in this project:\n${priorSolutions.map((s) => `- ${s.content} (${s.ref})`).join("\n")}` : "";
    return `## Defect ${d.id.slice(-6)} (${d.status.toLowerCase()}, seen ${d.occurrences}×)\n$ ${d.command} → exit ${d.exitCode}\n${d.diagnosis}\n${d.failingTests.length ? `Failing tests: ${d.failingTests.join("; ")}\n` : ""}${d.files.length ? `Implicated files: ${d.files.join(", ")}\n` : ""}Evidence (command run ${d.commandRunId}):\n${errorExcerpt(r?.output ?? "", 25)}${sol}`;
  }).join("\n\n");
}

export const RECURRENCE_STOP = 3;

/**
 * What to do after a failed attempt. The same failure in consecutive attempts
 * first escalates (stronger model, prior solutions); at RECURRENCE_STOP
 * occurrences the run stops instead of repeating an unproductive repair.
 */
export function repeatDecision(open: DefectView[], recurring: DefectView | null): { action: "continue" | "escalate" | "stop"; defect: DefectView | null } {
  if (!recurring) return { action: "continue", defect: null };
  const d = open.find((x) => x.signature === recurring.signature) ?? recurring;
  return { action: d.occurrences >= RECURRENCE_STOP ? "stop" : "escalate", defect: d };
}

/** Mark the run's unresolved defects ABANDONED when the run stops without fixing them. */
export async function abandonOpen(buildId: string) {
  await prisma.defect.updateMany({ where: { buildId, status: { in: ["OPEN", "RECURRING"] } }, data: { status: "ABANDONED" } });
}
