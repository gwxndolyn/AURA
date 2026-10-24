import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact, redactDeep } from "./redact";
import { assessTaskSafety, checkRequiredInputs, detectRefusal, detectEscalation } from "./policy";
import { auditSkills } from "./skillAudit";
import { executeBoundedTool } from "./harness";
import { canTransition, hashContent } from "./registry";

describe("redaction", () => {
  it("removes API keys, tokens, passwords, private keys", () => {
    const s = redact("key sk-ant-api03-abcdefghijkl and password: hunter2pass Bearer abc.def.ghijklmn AKIAABCDEFGHIJKLMNOP");
    expect(s).not.toMatch(/sk-ant-api03/);
    expect(s).not.toMatch(/hunter2pass/);
    expect(s).not.toMatch(/AKIAABCDEFGHIJKLMNOP/);
    expect(s).toMatch(/\[REDACTED/);
  });
  it("truncates long content and redacts deeply", () => {
    expect(redact("x".repeat(5000), 100).length).toBeLessThan(200);
    expect(redactDeep({ a: ["token=supersecret123"] })).toEqual({ a: ["token=[REDACTED]"] });
  });
});

describe("deterministic policy", () => {
  it("refuses offensive actions against real targets, allows the range", () => {
    expect(assessTaskSafety("Run a port scan against https://example-bank.com").allowed).toBe(false);
    expect(assessTaskSafety("Attack 203.0.113.10 on the public internet").allowed).toBe(false);
    expect(assessTaskSafety("Probe the cyber range for exploitable weaknesses").allowed).toBe(true);
    expect(assessTaskSafety("Run simulated Reflected XSS against the cyber range").allowed).toBe(true);
    expect(assessTaskSafety("Summarize the incident report").allowed).toBe(true);
  });
  it("does not block existing AURA workflow objectives", () => {
    for (const o of [
      "Detect and contain the attack on Customer API",
      "Patch AURA-2026-001: SQL Injection on Customer API",
      "Threat-model the application and assess security posture",
      "Deploy v0.3.0 to production",
    ]) expect(assessTaskSafety(o).allowed, o).toBe(true);
  });
  it("escalates on missing required inputs", () => {
    expect(checkRequiredInputs(["board_approval"], "").sufficient).toBe(false);
    expect(checkRequiredInputs(["board_approval"], "board_approval: yes").sufficient).toBe(true);
    expect(checkRequiredInputs(undefined, "").sufficient).toBe(true);
  });
  it("detects refusal and escalation markers", () => {
    expect(detectRefusal("I can't help with that request")).toBe(true);
    expect(detectEscalation("ESCALATE: need the customer segment")).toBe(true);
    expect(detectEscalation("Here is the plan")).toBe(false);
  });
});

describe("bounded tool executor", () => {
  const valid = (o: unknown): o is { ok: true } => !!o && (o as { ok?: boolean }).ok === true;
  it("times out instead of hanging", async () => {
    const r = await executeBoundedTool(() => new Promise(() => {}), valid, 20);
    expect(r).toMatchObject({ ok: false, category: "tool_timeout" });
  });
  it("rejects invalid output and classifies thrown errors", async () => {
    expect(await executeBoundedTool(async () => "garbage", valid, 100)).toMatchObject({ ok: false, category: "invalid_tool_output" });
    expect(await executeBoundedTool(async () => { throw new Error("boom"); }, valid, 100)).toMatchObject({ ok: false, category: "tool_execution_error" });
    expect(await executeBoundedTool(async () => ({ ok: true }), valid, 100)).toMatchObject({ ok: true });
  });
});

describe("registry lifecycle rules (pure)", () => {
  it("restricts transitions", () => {
    expect(canTransition("DRAFT", "EVALUATING")).toBe(true);
    expect(canTransition("DRAFT", "ACTIVE")).toBe(false);
    expect(canTransition("DEPRECATED", "ACTIVE")).toBe(false);
    expect(canTransition("ROLLED_BACK", "APPROVED")).toBe(true);
  });
  it("content hash is stable and sensitive to any content change", () => {
    const base = { content: "a", inputVars: ["x"], outputContract: "c", modelReqs: {}, datasetId: "d" };
    expect(hashContent(base)).toBe(hashContent({ ...base }));
    expect(hashContent(base)).not.toBe(hashContent({ ...base, content: "b" }));
    expect(hashContent(base)).not.toBe(hashContent({ ...base, datasetId: null }));
  });
});

describe("skill audit", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "aura-skill-audit-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc" } }));
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(join(root, "src", "lib", "real.ts"), "");
    const mk = (name: string, body: string) => {
      mkdirSync(join(root, ".claude", "skills", name), { recursive: true });
      writeFileSync(join(root, ".claude", "skills", name, "SKILL.md"), body);
    };
    mk("good-skill", `---\nname: good-skill\ndescription: Do X. Use when doing X.\n---\n## When to use\nx\n## Workflow\nsee \`src/lib/real.ts\`\n## Validation\n\`npm run typecheck\`\n## Definition of done\nx\n## Final report\nx\n`);
    mk("bad-skill", `---\nname: wrong-name\ndescription: Do Y.\nfoo: bar\n---\nRun \`npm run nope\` and read \`src/lib/missing.ts\` and [x](./nowhere.md).\n`);
    mk("security-thing", `---\nname: security-thing\ndescription: Audits. Use when auditing.\n---\n## When to use\n## Workflow\n## Validation\n\`npm test\`\n## Definition of done\n## Final report\n`);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("validates good skills and flags concrete problems in bad ones without rewriting", () => {
    const r = auditSkills(root);
    const by = Object.fromEntries(r.skills.map((s) => [s.skill, s]));
    expect(by["good-skill"].status).toBe("valid");
    const codes = by["bad-skill"].findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["name-mismatch", "unsupported-key", "invalid-command", "stale-path", "broken-link"]));
    expect(by["bad-skill"].status).toBe("manual-review");
    expect(r.staleReferences.some((s) => s.ref === "src/lib/missing.ts")).toBe(true);
    // security-sensitive skill with no security guidance is flagged
    expect(by["security-thing"].findings.map((f) => f.code)).toContain("missing-security");
  });
});
