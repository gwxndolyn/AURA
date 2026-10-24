import { describe, it, expect } from "vitest";
import { scoreTask } from "./prioritize";

describe("task prioritization scoring", () => {
  it("weights security risk most heavily", () => {
    const secure = scoreTask({ businessImpact: 3, urgency: 3, securityRisk: 5, dependents: 0, effort: 3 });
    const normal = scoreTask({ businessImpact: 3, urgency: 3, securityRisk: 1, dependents: 0, effort: 3 });
    expect(secure.score).toBeGreaterThan(normal.score);
    // 4 extra security points × weight 3 = +12
    expect(secure.score - normal.score).toBeCloseTo(12, 5);
  });

  it("rewards tasks that unblock others (dependents)", () => {
    const blocker = scoreTask({ businessImpact: 2, urgency: 2, securityRisk: 1, dependents: 4, effort: 3 });
    const leaf = scoreTask({ businessImpact: 2, urgency: 2, securityRisk: 1, dependents: 0, effort: 3 });
    expect(blocker.score - leaf.score).toBeCloseTo(4, 5);
  });

  it("penalizes higher engineering effort", () => {
    const cheap = scoreTask({ businessImpact: 3, urgency: 3, securityRisk: 1, dependents: 0, effort: 1 });
    const pricey = scoreTask({ businessImpact: 3, urgency: 3, securityRisk: 1, dependents: 0, effort: 9 });
    expect(cheap.score).toBeGreaterThan(pricey.score);
    expect(cheap.score - pricey.score).toBeCloseTo(4, 5); // (9-1)*0.5
  });

  it("produces an explanatory reason string", () => {
    const r = scoreTask({ businessImpact: 4, urgency: 4, securityRisk: 5, dependents: 0, effort: 4 });
    expect(r.reason).toContain("security 5×3");
    expect(r.score).toBeCloseTo(29, 5);
  });
});
