/** Chief-orchestrator policy (pure): risk-based gates, handoff contracts, recovery per failure category, disagreements. */
import { describe, it, expect } from "vitest";
import { assessRisk, reviewPlan, handoffFor, missingInputs, recoveryFor, resolveDisagreement, contextPackage } from "./orchestrator";
import { libraryPrompt, ROLE_CARDS, ENGINEERING_RULES, planningSystem, PROMPT_LIBRARY_VERSION } from "@/lib/agents/prompts";
import { AGENT_DEFS } from "@/lib/agents/definitions";
import { isAgentReadOnly } from "./workspace";

const task = (over: Partial<Parameters<typeof assessRisk>[0]> = {}) => ({ risk: "LOW", title: "Add a footer", description: "Static text", acceptance: ["Footer shows the year"], files: ["public/index.html"], ...over });

describe("risk-based verification", () => {
  it("raises risk for sensitive surfaces and never lowers the planner's risk", () => {
    expect(assessRisk(task()).risk).toBe("LOW");
    expect(assessRisk(task({ title: "Add login with password reset" }))).toMatchObject({ risk: "HIGH", reasons: ["authentication/authorization"] });
    expect(assessRisk(task({ description: "Charge the card via Stripe checkout" })).reasons).toContain("payments");
    expect(assessRisk(task({ risk: "HIGH" })).risk).toBe("HIGH");
  });

  it("proportionate reviewers: low = QA + review; medium adds security; high requires explicit approvals", () => {
    expect(reviewPlan("LOW", [])).toMatchObject({ reviewers: ["qa-engineer", "reviewer"], requireApproveVerdict: false });
    expect(reviewPlan("MEDIUM", []).reviewers).toEqual(["qa-engineer", "security-engineer", "reviewer"]);
    expect(reviewPlan("LOW", ["payments"]).reviewers).toContain("security-engineer");
    expect(reviewPlan("HIGH", ["payments"]).requireApproveVerdict).toBe(true);
  });
});

describe("structured handoffs", () => {
  const design = { id: "art_design_1", kind: "HANDOFF", version: 2, consumedBy: JSON.stringify(["E1.S1.T2"]), content: JSON.stringify({ designVersion: 2, pages: [{ id: "list" }], acceptance: ["List renders loading, empty and error states as specified"], accessibility: ["Inputs have labels"] }) };
  const arch = { id: "art_arch_1", kind: "ARCHITECTURE", version: 1, consumedBy: "[]", content: JSON.stringify({ contracts: [{ name: "POST /api/tasks", signature: "{title} → 201 {id}", rules: ["title is required (400 otherwise)"] }] }) };
  it("delivers only artifacts addressed to the task, and merges their acceptance lines into QA's checklist", () => {
    const mine = handoffFor("E1.S1.T2", "E1.S1", [design, arch]);
    expect(mine.design?.ref).toContain("v2");
    expect(mine.architecture?.ref).toContain("ARCHITECTURE");
    expect(mine.extraAcceptance).toEqual(["Design: List renders loading, empty and error states as specified", "Contract POST /api/tasks: title is required (400 otherwise)"]);
    const other = handoffFor("E1.S1.T1", "E1.S1", [design, arch]);
    expect(other.design).toBeNull(); // design handoff not addressed to T1
    expect(other.architecture).not.toBeNull(); // product-wide contracts apply to every task
  });

  it("downstream work does not start without its mandatory upstream artifact", () => {
    const product = { designTaskKeys: ["E1.S1.T0"], archTaskKeys: ["E1.S1.TA"], hasApprovedHandoff: false, hasApprovedArchitecture: false };
    expect(missingInputs({ kind: "FRONTEND", dependsOn: [] }, product)).toEqual(["approved design handoff"]);
    expect(missingInputs({ kind: "BACKEND", dependsOn: ["E1.S1.TA"] }, product)).toEqual(["approved architecture contracts"]);
    expect(missingInputs({ kind: "BACKEND", dependsOn: [] }, product)).toEqual([]);
    expect(missingInputs({ kind: "FRONTEND", dependsOn: [] }, { ...product, hasApprovedHandoff: true })).toEqual([]);
    expect(missingInputs({ kind: "FRONTEND", dependsOn: [] }, { ...product, designTaskKeys: [] })).toEqual([]); // no design task planned
  });
});

describe("failure-category recovery", () => {
  const d = (category: string, occurrences = 1) => ({ category: category as never, occurrences, title: "t", failingTests: [] });
  it("chooses a different strategy per category instead of repeating the instruction", () => {
    expect(recoveryFor([d("infrastructure")], 0).action).toBe("retry_later");
    expect(recoveryFor([d("permissions")], 0).action).toBe("retry_later");
    expect(recoveryFor([d("timeout")], 0)).toMatchObject({ action: "repair", strategy: "hang" });
    expect(recoveryFor([d("dependency")], 0).strategy).toBe("dependency");
    expect(recoveryFor([d("configuration")], 0).strategy).toBe("configuration");
    expect(recoveryFor([d("test_assumption")], 0).strategy).toBe("test_environment");
    expect(recoveryFor([d("code")], 0)).toMatchObject({ strategy: "code", tier: "same" });
    expect(recoveryFor([d("code", 2)], 1)).toMatchObject({ strategy: "rethink", tier: "escalate" });
    const briefs = new Set(["timeout", "dependency", "configuration", "test_assumption", "code"].map((c) => recoveryFor([d(c)], 0).brief));
    expect(briefs.size).toBe(5);
  });
});

describe("disagreement protocol", () => {
  it("evidence beats opinion; unsupported objections don't block; high risk needs every verdict", () => {
    const approve = (source: "qa" | "security" | "review") => ({ source, verdict: "approve" as const, blocking: [] });
    expect(resolveDisagreement([approve("qa"), approve("review")], { requireApproveVerdict: false }).block).toBe(false);
    const evidenced = resolveDisagreement([approve("qa"), { source: "security", verdict: "request_changes", blocking: [{ title: "SQL injection", evidence: "src/db.js:12 string concatenation" }] }], { requireApproveVerdict: false });
    expect(evidenced).toMatchObject({ block: true, disagreement: true });
    const unsupported = resolveDisagreement([approve("qa"), { source: "review", verdict: "request_changes", blocking: [] }], { requireApproveVerdict: false });
    expect(unsupported).toMatchObject({ block: false, disagreement: true });
    expect(unsupported.rationale).toMatch(/without evidence .* does not block/);
    expect(resolveDisagreement([approve("qa"), { source: "security", verdict: "missing", blocking: [] }], { requireApproveVerdict: true }).block).toBe(true);
    expect(resolveDisagreement([approve("qa"), { source: "security", verdict: "missing", blocking: [] }], { requireApproveVerdict: false }).block).toBe(false);
  });
});

describe("context engineering", () => {
  it("records provenance per section and respects the budget", () => {
    const p = contextPackage([{ id: "a", title: "A", body: "x".repeat(50), provenance: "file a @ sha" }, null, { id: "b", title: "B", body: "", provenance: "empty" }, { id: "c", title: "C", body: "y".repeat(100), provenance: "memory" }], 80);
    expect(p.manifest).toEqual([{ id: "a", provenance: "file a @ sha", chars: 50 }, { id: "c", provenance: "memory", chars: 30 }]);
    expect(p.text.startsWith("# A\n")).toBe(true);
  });
});

describe("prompt library", () => {
  it("every core engineering agent has an operational prompt with all mandatory sections and rules", () => {
    for (const key of ["product-manager", "designer", "architect", "frontend-engineer", "backend-engineer", "qa-engineer", "security-engineer", "reviewer", "devops"]) {
      const p = libraryPrompt(key)!;
      for (const h of ["## Objective", "## You are responsible for", "## You are NOT responsible for", "## Inputs you rely on", "## Output", "## Tools", "## Decision rules", "## Collaboration", "## Quality bar", "## Done means", "## Never", "## Security"]) expect(p, `${key} ${h}`).toContain(h);
      if (ROLE_CARDS[key].engineering) expect(p).toContain(ENGINEERING_RULES);
      expect(AGENT_DEFS.find((a) => a.key === key)!.systemPrompt).toBe(p);
    }
  });
  it("the security prompt no longer claims to work only on the simulation", () => {
    expect(libraryPrompt("security-engineer")).not.toMatch(/simulation only/i);
    expect(libraryPrompt("security-engineer")).toMatch(/real customer code/);
  });
  it("reviewers must return a verdict; QA and the code reviewer have distinct names", () => {
    for (const k of ["qa-engineer", "security-engineer", "reviewer"]) expect(libraryPrompt(k)).toMatch(/"verdict":"approve"\|"request_changes"/);
    expect(AGENT_DEFS.find((a) => a.key === "reviewer")!.name).not.toBe(AGENT_DEFS.find((a) => a.key === "qa-engineer")!.name);
  });
  it("planning prompts keep the identity + rules and are versioned", () => {
    expect(planningSystem("product-manager", "change")).toMatch(/maintaining an EXISTING application/);
    expect(PROMPT_LIBRARY_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d+$/);
  });
});

describe("self-modification guard", () => {
  it("agents cannot write CI, AURA policy or hook files", () => {
    for (const p of [".github/workflows/ci.yml", ".gitlab-ci.yml", ".aura/policy.json", ".husky/pre-commit", ".claude/settings.json"]) expect(isAgentReadOnly(p)).toBe(true);
    for (const p of ["src/app.js", "public/index.html", "src/routes/github.js"]) expect(isAgentReadOnly(p)).toBe(false);
  });
});
