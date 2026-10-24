/**
 * The deterministic verification gate of an engineering run: given the
 * engine's executed checks and the static change-impact analysis, may the
 * change be accepted? Model review (QA / security / reviewer agents) is
 * applied ON TOP of this by the engine; this gate is the part that does not
 * depend on any model.
 *
 * The gate is a versioned policy so AURA's engineering lab
 * (src/lib/lab) can evaluate alternative policies against the same
 * benchmarks before one becomes the default. `v1` is the behaviour the
 * engine shipped with.
 */
import type { Impact } from "./intel";
import { isTestFile } from "./intel";

export interface GatePolicy {
  id: string;
  description: string;
  /** Reject when a changed test file contains no assertions (vacuous tests pass trivially). */
  assertionFreeTests: boolean;
  /** Reject when a test that existed before the change loses test cases or assertions. */
  weakenedPreexistingTests: boolean;
  /** Reject when an existing API route disappears and the task text does not ask for its removal. */
  unrequestedRouteRemoval: boolean;
  /** Reject when changed source code evaluates dynamic code or spawns shell commands. */
  dangerousCode: boolean;
  /** v3: assertions must be able to fail — tautologies (assert.ok(true), x === x) do not count. */
  tautologicalAssertions?: boolean;
  /** v3: broader dynamic-code detection (Function(), vm.run*). */
  dynamicCodeV3?: boolean;
}

export const GATE_POLICIES: Record<string, GatePolicy> = {
  v1: { id: "v1", description: "Shipped gate: every engine check passes, a test command exists, no confirmed static breakage.", assertionFreeTests: false, weakenedPreexistingTests: false, unrequestedRouteRemoval: false, dangerousCode: false },
  // Candidate (lab experiment gate-v2): adds evidence-quality and safety rules found missing by the lab's train cases.
  v2: { id: "v2", description: "v1 + reject assertion-free tests, weakened pre-existing tests, unrequested route removal, and newly introduced eval/shell execution.", assertionFreeTests: true, weakenedPreexistingTests: true, unrequestedRouteRemoval: true, dangerousCode: true },
  // Candidate (lab experiment gate-v3): designed from train cases gate-h4-weakened-assertion / gate-h4-function-constructor.
  v3: { id: "v3", description: "v2 + assertions must be able to fail (no tautologies; pre-existing tests may not lose real assertions) + Function()/vm code execution.", assertionFreeTests: true, weakenedPreexistingTests: true, unrequestedRouteRemoval: true, dangerousCode: true, tautologicalAssertions: true, dynamicCodeV3: true },
};
export const DEFAULT_GATE_POLICY = "v1";

export interface GateInput {
  results: { id: string; ok: boolean; command: string }[];
  hasTest: boolean;
  impact: Impact;
  /** Task / requirement text (used only to recognise explicitly requested removals). */
  task: string;
  beforeFiles: Record<string, string>;
  afterFiles: Record<string, string>;
}

export interface GateReason { code: string; detail: string }
export interface GateVerdict { accept: boolean; policy: string; reasons: GateReason[] }

/** Reason codes produced by v1 (the engine already reports them as findings). */
export const V1_REASON_CODES = ["check_failed", "no_tests", "confirmed_flag"];

const ASSERT = /\bassert(?:\.\w+)?\s*\(|\bexpect\s*\(|\bt\.(?:assert|ok|equal|deepEqual|throws)\b/;
const DANGER = /\beval\s*\(|new\s+Function\s*\(|child_process|\bexecSync\s*\(|\bspawnSync\s*\(/;
const DANGER_V3 = /\beval\s*\(|\bFunction\s*\(|child_process|\bexecSync\s*\(|\bspawnSync\s*\(|\bvm\.(?:runIn\w*|Script|compileFunction)\b|require\(\s*["'](?:node:)?vm["']\s*\)/;

/**
 * Real (falsifiable) assertions in a test source. Tautologies are excluded:
 * assert(true) / assert.ok(1) / assert.ok(1 === 1), assert.equal(x, x), expect(true).toBe(true).
 */
export function realAssertions(src: string): number {
  const calls = [...src.matchAll(/\bassert(?:\.(\w+))?\s*\(([^;\n]*)\)/g), ...src.matchAll(/\bexpect\s*\(([^)]*)\)\.(?:not\.)?\w+\(([^)]*)\)/g)];
  let n = 0;
  for (const m of calls) {
    const args = (m[2] ?? m[1] ?? "").trim();
    const parts = args.split(",").map((x) => x.trim()).filter(Boolean);
    const constant = /^(true|1|!0|"[^"]*"|'[^']*'|\d+\s*===?\s*\d+|(\w+)\s*===?\s*\2)$/.test(parts[0] ?? "") && parts.length <= 2 && (parts.length === 1 || /^["'`]/.test(parts[1]));
    const selfEqual = parts.length >= 2 && parts[0] === parts[1];
    if (!constant && !selfEqual) n++;
  }
  return n;
}

export function gateVerdict(policy: GatePolicy, input: GateInput): GateVerdict {
  const reasons: GateReason[] = [];
  for (const r of input.results.filter((x) => !x.ok && x.id !== "focused_test")) reasons.push({ code: "check_failed", detail: `${r.id} failed: ${r.command}` });
  if (!input.hasTest) reasons.push({ code: "no_tests", detail: "the project has no test command" });
  for (const f of input.impact.flags.filter((x) => x.confidence === "confirmed")) reasons.push({ code: "confirmed_flag", detail: `${f.kind}: ${f.detail}` });
  const changed = input.impact.changed;

  if (policy.assertionFreeTests) {
    for (const p of changed.filter((c) => isTestFile(c) && input.afterFiles[c] !== undefined)) {
      if (!ASSERT.test(input.afterFiles[p])) reasons.push({ code: "assertion_free_tests", detail: `${p} contains no assertions; passing it proves nothing` });
    }
  }
  if (policy.weakenedPreexistingTests) {
    for (const f of input.impact.flags.filter((x) => x.kind === "test_weakened")) {
      if (f.files.some((p) => input.beforeFiles[p] !== undefined)) reasons.push({ code: "weakened_preexisting_test", detail: f.detail });
    }
  }
  if (policy.unrequestedRouteRemoval) {
    const asksRemoval = /\b(remove|delete|drop|deprecate|rename|replace)\b/i.test(input.task);
    for (const f of input.impact.flags.filter((x) => x.kind === "api_breaking")) if (!asksRemoval) reasons.push({ code: "unrequested_route_removal", detail: f.detail });
  }
  if (policy.dangerousCode) {
    const re = policy.dynamicCodeV3 ? DANGER_V3 : DANGER;
    for (const p of changed.filter((c) => !isTestFile(c) && /\.(c|m)?(j|t)sx?$/.test(c) && input.afterFiles[c] !== undefined)) {
      const before = input.beforeFiles[p] ?? "";
      if (re.test(input.afterFiles[p]) && !re.test(before)) reasons.push({ code: "dangerous_code", detail: `${p} introduces dynamic code evaluation or shell execution` });
    }
  }
  if (policy.tautologicalAssertions) {
    for (const p of changed.filter((c) => isTestFile(c) && input.afterFiles[c] !== undefined)) {
      const after = realAssertions(input.afterFiles[p]);
      const before = input.beforeFiles[p] !== undefined ? realAssertions(input.beforeFiles[p]) : null;
      if (after === 0 && !reasons.some((r) => r.code === "assertion_free_tests")) reasons.push({ code: "tautological_assertions", detail: `${p} has no assertion that can fail` });
      else if (before !== null && after < before) reasons.push({ code: "weakened_preexisting_test", detail: `${p}: real assertions ${before} → ${after}` });
    }
  }
  return { accept: reasons.length === 0, policy: policy.id, reasons };
}
