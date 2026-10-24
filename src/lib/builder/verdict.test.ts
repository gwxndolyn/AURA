/** Verification gate policies: v1 keeps shipped behaviour; v2 rules each fire only on their defect class. */
import { describe, it, expect } from "vitest";
import { gateVerdict, GATE_POLICIES } from "./verdict";
import type { Impact } from "./intel";

const impact = (over: Partial<Impact> = {}): Impact => ({ changed: [], dependents: [], tests: [], routes: [], flags: [], parser: "typescript", limitations: [], ...over });
const ok = [{ id: "test", ok: true, command: "npm test --silent" }];

describe("gate policies", () => {
  it("v1 accepts any change whose checks pass (the weakness the lab measured)", () => {
    const v = gateVerdict(GATE_POLICIES.v1, { results: ok, hasTest: true, impact: impact({ changed: ["src/a.test.js"] }), task: "x", beforeFiles: {}, afterFiles: { "src/a.test.js": 'test("x", () => {});' } });
    expect(v.accept).toBe(true);
  });
  it("v1 and v2 both reject failing checks and missing tests", () => {
    for (const p of [GATE_POLICIES.v1, GATE_POLICIES.v2]) {
      expect(gateVerdict(p, { results: [{ id: "test", ok: false, command: "npm test" }], hasTest: true, impact: impact(), task: "", beforeFiles: {}, afterFiles: {} }).reasons[0].code).toBe("check_failed");
      expect(gateVerdict(p, { results: [], hasTest: false, impact: impact(), task: "", beforeFiles: {}, afterFiles: {} }).reasons[0].code).toBe("no_tests");
    }
  });
  it("v2 rejects assertion-free tests but accepts asserting ones", () => {
    const run = (src: string) => gateVerdict(GATE_POLICIES.v2, { results: ok, hasTest: true, impact: impact({ changed: ["src/a.test.js"] }), task: "", beforeFiles: {}, afterFiles: { "src/a.test.js": src } });
    expect(run('test("x", () => { f(); });').reasons.map((r) => r.code)).toEqual(["assertion_free_tests"]);
    expect(run('test("x", () => { assert.strictEqual(f(), 1); });').accept).toBe(true);
  });
  it("v2 rejects removal of a route only when the task did not ask for it", () => {
    const flags = [{ kind: "api_breaking" as const, severity: "high" as const, confidence: "warning" as const, detail: "Route GET /api/x no longer exists", files: ["src/r.js"] }];
    const base = { results: ok, hasTest: true, impact: impact({ flags }), beforeFiles: {}, afterFiles: {} };
    expect(gateVerdict(GATE_POLICIES.v2, { ...base, task: "Add a count endpoint" }).accept).toBe(false);
    expect(gateVerdict(GATE_POLICIES.v2, { ...base, task: "Remove the deprecated GET /api/x endpoint" }).accept).toBe(true);
  });
  it("v2 rejects newly introduced eval/shell but not code that already had it", () => {
    const run = (before: string | undefined, after: string) => gateVerdict(GATE_POLICIES.v2, { results: ok, hasTest: true, impact: impact({ changed: ["src/a.js"] }), task: "", beforeFiles: before === undefined ? {} : { "src/a.js": before }, afterFiles: { "src/a.js": after } });
    expect(run("module.exports = 1;", "module.exports = eval(x);").reasons[0].code).toBe("dangerous_code");
    expect(run(undefined, 'require("node:child_process").execSync(cmd)').reasons[0].code).toBe("dangerous_code");
    expect(run("eval(a)", "eval(a); // unchanged").accept).toBe(true);
  });
});
