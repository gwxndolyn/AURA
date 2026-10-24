/**
 * Landing-page guided demo: a deterministic, scripted replay of AURA's real
 * "checkout-validation" workflow. Everything here is DEMO content and is
 * labelled as such in the UI:
 *
 *   - Project files and diffs are the real fixture (src/lib/missions/repos.ts).
 *     The two code changes are AURA's prepared repair candidates — exactly what
 *     the engineer applies in simulation mode (no API key).
 *   - The plan is the real planner output for this template (asserted equal
 *     to engineeringPlan("checkout-validation") in demo-script.test.ts).
 *   - Test and probe results are RECORDED from real Docker sandbox runs
 *     (recording.ts) and replayed — not executed live on the landing page.
 *   - Agent interactions are scripted to mirror the engine's handoffs and
 *     findings; they are not persisted communications.
 *
 * Each step declares task statuses; the office derives character state from
 * them with the same mapper the live office uses (state.ts).
 */
import { VALIDATION_FIXTURE } from "@/lib/missions/repos";
import { lineDiff } from "@/lib/missions/diff";
import { getAgentDef } from "@/lib/agents/definitions";
import { DEMO_RECORDING } from "./recording";
import type { OfficeInteraction, OfficeTaskInput } from "./state";

export const DEMO_PROJECT = {
  id: "checkout-validation",
  name: "NOVA PAY checkout",
  description: "A small storefront checkout module with input validation and a node:test suite.",
  files: [
    { path: "src/checkout/validation.js", content: VALIDATION_FIXTURE.BUGGY },
    { path: "src/checkout/validation.test.js", content: VALIDATION_FIXTURE.TESTS },
  ],
  ticket: "Support ticket #4502: orders with quantity 0 passed checkout validation and reached the payment provider as $0 charges.",
};

export const DEMO_TASK_TEXT = "Find and fix the validation bug in this form";

/** Real planner output for the checkout-validation template (LOW risk, 2 repair rounds). */
export const DEMO_PLAN = [
  { key: "requirements", kind: "REQUIREMENTS", agentKey: "product-manager", title: "Clarify requirements", dependsOn: [] as string[] },
  { key: "architecture", kind: "ARCHITECTURE", agentKey: "architect", title: "Locate the defect and propose a boundary", dependsOn: ["requirements"] },
  { key: "reproduce", kind: "REPRODUCE", agentKey: "qa-engineer", title: "Reproduce with the existing tests", dependsOn: ["requirements"] },
  { key: "fix", kind: "CODE_CHANGE", agentKey: "backend-engineer", title: "Implement the minimal fix", dependsOn: ["architecture", "reproduce"] },
  { key: "verify", kind: "TEST", agentKey: "qa-engineer", title: "Run the relevant tests", dependsOn: ["fix"] },
  { key: "review", kind: "REVIEW", agentKey: "reviewer", title: "Independent code review", dependsOn: ["verify"] },
  { key: "report", kind: "REPORT", agentKey: "product-manager", title: "Write the mission report", dependsOn: ["review"] },
] as const;

export const DEMO_ACCEPTANCE = [
  "The failing validation test passes in the sandbox, with no other test regressing.",
  "The change stays inside the declared write scope.",
  "An independent review finds no blocking issue backed by evidence.",
];

/** Agents shown in the demo office: everyone on the plan plus a few teammates who stay idle (honestly). */
export const DEMO_AGENTS = ["product-manager", "architect", "designer", "frontend-engineer", "backend-engineer", "qa-engineer", "reviewer", "security-engineer", "devops"].map((key) => {
  const d = getAgentDef(key)!;
  return { key, name: d.name, role: d.role };
});

export type DemoPanel =
  | { type: "project" }
  | { type: "task" }
  | { type: "plan" }
  | { type: "code"; file: string; highlight: string; note: string }
  | { type: "tests"; runs: string[]; note: string }
  | { type: "diff"; title: string; before: string; after: string; note: string }
  | { type: "review"; runs: string[]; finding?: { code: string; title: string; blocking: boolean } }
  | { type: "evidence" };

export interface DemoStep {
  id: string;
  title: string;
  /** One or two sentences: what the team is doing and why. */
  caption: string;
  panel: DemoPanel;
  /** Task statuses at this step (keys from DEMO_PLAN). */
  tasks: Partial<Record<(typeof DEMO_PLAN)[number]["key"], "PENDING" | "READY" | "RUNNING" | "SUCCEEDED" | "FAILED">>;
  interactions?: Omit<OfficeInteraction, "id" | "at" | "demo">[];
  focus?: string; // agent key to highlight
  /** Activity lines appended to each agent's history when this step is reached. */
  log?: Record<string, string>;
}

const allPending = Object.fromEntries(DEMO_PLAN.map((t) => [t.key, "PENDING"])) as DemoStep["tasks"];

export const DEMO_STEPS: DemoStep[] = [
  { id: "project", title: "Pick a project", caption: "AURA works on a codebase. This demo uses a small checkout module with a real test suite.", panel: { type: "project" }, tasks: {} },
  { id: "task", title: "Describe the task", caption: "Tell the team what you want in plain language.", panel: { type: "task" }, tasks: {} },
  {
    id: "plan",
    title: "AURA plans the work",
    caption: "The planner breaks the task into dependent steps and assigns each to the agent whose capabilities match. Nothing runs until you approve the plan.",
    panel: { type: "plan" },
    tasks: { ...allPending, requirements: "READY" },
    focus: "product-manager",
  },
  {
    id: "requirements",
    title: "Requirements, then the code",
    caption: "Maya turns the ticket into acceptance criteria and hands them to Kai and Iris. Kai reads validation.js and finds the boundary: quantity is only checked for < 0.",
    panel: { type: "code", file: "src/checkout/validation.js", highlight: "if (item.quantity < 0)", note: "The defect: a quantity of 0 passes validation." },
    tasks: { ...allPending, requirements: "SUCCEEDED", architecture: "RUNNING", reproduce: "READY" },
    interactions: [{ kind: "handoff", from: "product-manager", to: ["architect", "qa-engineer"], text: "Handoff: requirements + 3 acceptance criteria" }],
    focus: "architect",
    log: { "product-manager": "Wrote requirements and acceptance criteria", architect: "Reading src/checkout/validation.js" },
  },
  {
    id: "reproduce",
    title: "Reproduce the bug",
    caption: "Before anyone changes code, Iris (QA) runs the existing suite in the sandbox. One test fails: the bug is real.",
    panel: { type: "tests", runs: ["reproduce"], note: "Reproduced on the unchanged code." },
    tasks: { ...allPending, requirements: "SUCCEEDED", architecture: "SUCCEEDED", reproduce: "RUNNING" },
    interactions: [{ kind: "handoff", from: "architect", to: ["backend-engineer"], text: "Handoff: affected file + smallest safe change" }],
    focus: "qa-engineer",
    log: { architect: "Named the affected file and the safe boundary", "qa-engineer": "Ran the suite: 4 passed, 1 failed" },
  },
  {
    id: "fix",
    title: "Atlas writes a fix",
    caption: "Atlas changes only the file in the task's write scope. Any other path would be rejected by the tool runner.",
    panel: { type: "diff", title: "Attempt 1 — reject quantity <= 0", before: VALIDATION_FIXTURE.BUGGY, after: VALIDATION_FIXTURE.MINIMAL, note: "Write scope: src/checkout/validation.js" },
    tasks: { ...allPending, requirements: "SUCCEEDED", architecture: "SUCCEEDED", reproduce: "SUCCEEDED", fix: "RUNNING" },
    focus: "backend-engineer",
    log: { "backend-engineer": "Proposed change to src/checkout/validation.js" },
  },
  {
    id: "verify",
    title: "Verify in the sandbox",
    caption: "Iris (QA) re-runs the full suite on the changed code. Everything passes, but passing tests are not the finish line.",
    panel: { type: "tests", runs: ["verify-1"], note: "Results decide; the implementer's description does not." },
    tasks: { ...allPending, requirements: "SUCCEEDED", architecture: "SUCCEEDED", reproduce: "SUCCEEDED", fix: "SUCCEEDED", verify: "RUNNING" },
    interactions: [{ kind: "review_request", from: "backend-engineer", to: ["qa-engineer"], text: "Please verify attempt 1" }],
    focus: "qa-engineer",
    log: { "qa-engineer": "Verified attempt 1: 5/5 passed" },
  },
  {
    id: "review",
    title: "Independent review finds a gap",
    caption: "The code reviewer checks the change, and every concern must be backed by an executed probe. 1.5, NaN and \"2\" still pass validation, so the reviewer raises a blocking finding and sends it back to Atlas.",
    panel: { type: "review", runs: ["review-1"], finding: { code: "F-1", title: "Quantity is range-checked but not type-checked", blocking: true } },
    tasks: { ...allPending, requirements: "SUCCEEDED", architecture: "SUCCEEDED", reproduce: "SUCCEEDED", fix: "SUCCEEDED", verify: "SUCCEEDED", review: "RUNNING" },
    interactions: [{ kind: "finding", from: "reviewer", to: ["backend-engineer"], text: "F-1 (blocking): 3 probes fail on attempt 1" }],
    focus: "reviewer",
    log: { reviewer: "Ran 3 probes: 0 passed. Raised F-1 (blocking)" },
  },
  {
    id: "repair",
    title: "A bounded repair",
    caption: "Atlas addresses F-1 by id. Repairs are capped at two rounds; after that the mission stops and asks you.",
    panel: { type: "diff", title: "Repair round 1 of 2 — require an integer quantity ≥ 1 (addresses F-1)", before: VALIDATION_FIXTURE.BUGGY, after: VALIDATION_FIXTURE.FIXED, note: "Diff against the original project revision." },
    tasks: { ...allPending, requirements: "SUCCEEDED", architecture: "SUCCEEDED", reproduce: "SUCCEEDED", fix: "RUNNING" },
    focus: "backend-engineer",
    log: { "backend-engineer": "Repair round 1: addressed F-1" },
  },
  {
    id: "reverify",
    title: "Re-verify and re-review",
    caption: "The suite passes again, and this time every reviewer probe passes too. F-1 is resolved by evidence, not by assertion.",
    panel: { type: "review", runs: ["verify-2", "review-2"] },
    tasks: { ...allPending, requirements: "SUCCEEDED", architecture: "SUCCEEDED", reproduce: "SUCCEEDED", fix: "SUCCEEDED", verify: "SUCCEEDED", review: "RUNNING" },
    interactions: [{ kind: "handoff", from: "qa-engineer", to: ["reviewer"], text: "Handoff: 5/5 tests on the repair" }],
    focus: "reviewer",
    log: { "qa-engineer": "Verified the repair: 5/5 passed", reviewer: "Re-ran the probes: 3/3 passed. F-1 resolved" },
  },
  {
    id: "evidence",
    title: "Review the evidence and decide",
    caption: "Maya writes the report. The change now waits for you: accept it into the project or reject it. Nothing is deployed.",
    panel: { type: "evidence" },
    tasks: { requirements: "SUCCEEDED", architecture: "SUCCEEDED", reproduce: "SUCCEEDED", fix: "SUCCEEDED", verify: "SUCCEEDED", review: "SUCCEEDED", report: "RUNNING" },
    interactions: [{ kind: "approval", from: "product-manager", to: ["you"], text: "Waiting for you: accept or reject the change" }],
    focus: "product-manager",
    log: { "product-manager": "Wrote the report with linked evidence" },
  },
];

export type RecordedRun = (typeof DEMO_RECORDING)["runs"][number];
export function recordedRun(id: string): RecordedRun {
  const r = DEMO_RECORDING.runs.find((x) => x.id === id);
  if (!r) throw new Error(`No recorded run ${id}`);
  return r;
}

export function demoDiff(before: string, after: string) {
  return lineDiff(before, after);
}

/** Office inputs at a step (fixed clock so the mapper's recency windows always apply). */
export const DEMO_NOW = Date.parse("2026-10-20T08:00:00Z");
export function demoTasksAt(step: DemoStep): OfficeTaskInput[] {
  return DEMO_PLAN.filter((t) => step.tasks[t.key]).map((t, i) => ({
    id: `demo-${t.key}`,
    key: t.key,
    title: t.title,
    kind: t.kind,
    agentKey: t.agentKey,
    status: step.tasks[t.key]!,
    missionId: "demo",
    missionTitle: DEMO_TASK_TEXT,
    missionStatus: "RUNNING",
    startedAt: new Date(DEMO_NOW - (DEMO_PLAN.length - i) * 1000).toISOString(),
    // "completed" shows only for the most recent finishers; older ones read as idle.
    completedAt: step.tasks[t.key] === "SUCCEEDED" ? new Date(DEMO_NOW - (i >= DEMO_PLAN.length - 3 ? 60_000 : 3_600_000)).toISOString() : null,
  }));
}

export function demoInteractionsAt(step: DemoStep): OfficeInteraction[] {
  return (step.interactions ?? []).map((x, i) => ({ ...x, id: `${step.id}-${i}`, at: new Date(DEMO_NOW).toISOString(), demo: true }));
}

/** Per-agent activity history up to and including step `index`. */
export function demoHistory(index: number): Record<string, { step: string; text: string }[]> {
  const out: Record<string, { step: string; text: string }[]> = {};
  for (const s of DEMO_STEPS.slice(0, index + 1)) for (const [k, text] of Object.entries(s.log ?? {})) (out[k] ??= []).unshift({ step: s.title, text });
  return out;
}
