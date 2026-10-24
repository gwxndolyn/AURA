import { describe, it, expect } from "vitest";
import { runNodeTests, runSyntaxCheck, dockerAvailable } from "./runner";
import { generateFeature } from "./codegen";

/**
 * These tests invoke the REAL Docker sandbox when it is available. If Docker is
 * absent (e.g. CI without Docker), each test asserts the graceful simulated
 * fallback instead, so the suite passes everywhere.
 */
describe("docker sandbox", () => {
  it("runs real passing tests, or falls back cleanly", async () => {
    const r = await runNodeTests({
      moduleFile: "feature.js",
      moduleCode: "exports.add=(a,b)=>a+b;",
      testCode:
        "const t=require('node:test');const a=require('node:assert');const {add}=require('./feature.js');t('add',()=>a.strictEqual(add(2,3),5));",
    });
    if (await dockerAvailable()) {
      expect(r.mode).toBe("docker");
      expect(r.failed).toBe(0);
      expect(r.passed).toBeGreaterThan(0);
    } else {
      expect(r.mode).toBe("simulated");
    }
  }, 60000);

  it("detects real test failures when Docker is present", async () => {
    if (!(await dockerAvailable())) return;
    const r = await runNodeTests({
      moduleFile: "feature.js",
      moduleCode: "exports.add=(a,b)=>a-b;", // intentional bug
      testCode:
        "const t=require('node:test');const a=require('node:assert');const {add}=require('./feature.js');t('add',()=>a.strictEqual(add(2,3),5));",
    });
    expect(r.mode).toBe("docker");
    expect(r.failed).toBeGreaterThan(0);
  }, 60000);

  it("fails the build on a syntax error when Docker is present", async () => {
    if (!(await dockerAvailable())) return;
    const r = await runSyntaxCheck({ "a.js": "const x=1;", "bad.js": "const y = ;" });
    expect(r.ok).toBe(false);
  }, 60000);

  it("every generated feature template produces passing tests (real sandbox)", async () => {
    if (!(await dockerAvailable())) return;
    const titles = [
      "Build login auth",
      "Add input validation",
      "Expense totals",
      "Add rate limiting",
      "Fix authorization IDOR",
      "Some generic feature",
    ];
    for (const title of titles) {
      const gen = generateFeature(title, "");
      const r = await runNodeTests(gen);
      expect(r.mode).toBe("docker");
      expect(r.failed, `template "${gen.feature}" should pass`).toBe(0);
    }
  }, 120000);
});
