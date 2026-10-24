import { describe, it, expect } from "vitest";
import { simulatedCompletion, pickAttackScenario, simPlan } from "./simulator";
import { seededRandom } from "@/lib/utils";

describe("simulator", () => {
  it("produces a structured plan with assignable tasks", () => {
    const json = simulatedCompletion({ system: "", prompt: "Build the MVP", kind: "plan" });
    const plan = JSON.parse(json);
    expect(plan.strategy).toContain("Build the MVP");
    expect(plan.tasks.length).toBeGreaterThan(0);
    for (const t of plan.tasks) {
      expect(t.title).toBeTruthy();
      expect(t.assignee).toBeTruthy();
      expect(Array.isArray(t.acceptance)).toBe(true);
    }
  });

  it("routes security goals to security-focused tasks", () => {
    const plan = simPlan("Find security vulnerabilities", seededRandom(1));
    const assignees = plan.tasks.map((t) => t.assignee);
    expect(assignees).toContain("red-team");
    expect(assignees).toContain("security-engineer");
  });

  it("is deterministic for the same seed", () => {
    const a = simulatedCompletion({ system: "", prompt: "x", kind: "attack", seed: "abc" });
    const b = simulatedCompletion({ system: "", prompt: "x", kind: "attack", seed: "abc" });
    expect(a).toBe(b);
  });

  it("produces a valid attack scenario labeled as simulated", () => {
    const json = simulatedCompletion({ system: "", prompt: "attack", kind: "attack", seed: "s1" });
    const s = JSON.parse(json);
    expect(s.attackType).toBeTruthy();
    expect(s.target).toBeTruthy();
    expect(s.note).toMatch(/SIMULATED/);
  });

  it("test output has consistent pass/fail accounting", () => {
    const json = simulatedCompletion({ system: "", prompt: "t", kind: "test", seed: "t1" });
    const r = JSON.parse(json);
    expect(r.passed + r.failed).toBe(r.total);
    expect(r.cases.filter((c: any) => c.ok).length).toBe(r.passed);
  });

  it("pickAttackScenario returns a known scenario shape", () => {
    const s = pickAttackScenario("seed-123");
    expect(s).toHaveProperty("type");
    expect(s).toHaveProperty("severity");
    expect(s.cvss).toBeGreaterThan(0);
  });
});
