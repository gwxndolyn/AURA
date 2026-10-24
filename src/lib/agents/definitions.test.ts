import { describe, it, expect } from "vitest";
import { AGENT_DEFS, getAgentDef, AGENT_BY_KEY } from "./definitions";

describe("agent registry", () => {
  it("defines the core roles", () => {
    const keys = AGENT_DEFS.map((a) => a.key);
    for (const required of [
      "ceo",
      "product-manager",
      "architect",
      "frontend-engineer",
      "backend-engineer",
      "devops",
      "qa-engineer",
      "security-engineer",
      "red-team",
      "blue-team",
    ]) {
      expect(keys).toContain(required);
    }
  });

  it("every agent has a unique key, prompt, color and tier", () => {
    const keys = new Set<string>();
    for (const a of AGENT_DEFS) {
      expect(keys.has(a.key)).toBe(false);
      keys.add(a.key);
      expect(a.systemPrompt.length).toBeGreaterThan(20);
      expect(a.color).toMatch(/^#/);
      expect(["FAST", "STANDARD", "REASONING"]).toContain(a.tier);
    }
  });

  it("red team prompt constrains to the sandbox", () => {
    const ghost = getAgentDef("red-team");
    expect(ghost?.systemPrompt.toLowerCase()).toContain("sandbox");
  });

  it("lookup map matches the list", () => {
    expect(Object.keys(AGENT_BY_KEY).length).toBe(AGENT_DEFS.length);
    expect(getAgentDef("nope")).toBeUndefined();
  });
});
