/**
 * Structured output contracts per mission task kind, plus the handoff contract.
 *
 * Every task execution produces an object that MUST validate against its
 * kind's schema before dependents may consume it. Evidence fields (test
 * results, finding evidence, code hashes) are populated by the engine from
 * tool results — never copied from model prose. The model's own narrative is
 * stored separately as a `claim`.
 */
import { z } from "zod";

const Str = (max = 400) => z.string().min(1).max(max);

export const TestEvidenceSchema = z.object({
  artifactId: z.string().min(1),
  mode: z.enum(["docker", "simulated"]),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  total: z.number().int().min(1),
  failing: z.array(Str(300)).max(50),
});
export type TestEvidence = z.infer<typeof TestEvidenceSchema>;

export const FindingDraftSchema = z.object({
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  blocking: z.boolean(),
  title: Str(160),
  description: Str(800),
  file: z.string().max(200).default(""),
  recommendation: z.string().max(600).default(""),
  /** A finding must point at concrete evidence that the engine can re-check. */
  evidence: z.object({
    artifactId: z.string().optional(),
    probe: z.string().max(80).optional(),
    case: z.string().max(300).optional(),
    codeHash: z.string().optional(),
  }),
});
export type FindingDraft = z.infer<typeof FindingDraftSchema>;

export const OUTPUT_SCHEMAS = {
  REQUIREMENTS: z.object({
    requirements: z.array(Str()).min(1).max(12),
    acceptanceCriteria: z.array(Str()).min(1).max(12),
    openQuestions: z.array(Str()).max(10).default([]),
    constraints: z.array(Str()).max(10).default([]),
  }),
  ANALYSIS: z.object({
    summary: Str(1200),
    suspectedCause: z.string().max(600).default(""),
    affectedFiles: z.array(Str(200)).max(20).default([]),
    recommendations: z.array(Str()).max(10).default([]),
  }),
  ARCHITECTURE: z.object({
    proposal: Str(1200),
    affectedFiles: z.array(Str(200)).min(1).max(20),
    interfaceChanges: z.array(Str()).max(10).default([]),
    risks: z.array(Str()).max(10).default([]),
    recommendations: z.array(Str()).max(10).default([]),
  }),
  REPRODUCE: z.object({
    reproduced: z.boolean(),
    tests: TestEvidenceSchema,
  }),
  CODE_CHANGE: z.object({
    files: z.array(z.object({ path: Str(200), diffArtifactId: z.string().min(1), fileArtifactId: z.string().min(1), added: z.number().int(), removed: z.number().int(), codeHash: z.string().length(64) })).min(1),
    change: Str(300),
    addressesFindings: z.array(z.string()).max(20),
    author: z.enum(["model-assisted", "simulated-candidate"]),
  }),
  TEST: z.object({
    passed: z.boolean(),
    tests: TestEvidenceSchema,
    codeHash: z.string().length(64),
  }),
  REVIEW: z.object({
    verdict: z.enum(["approve", "changes_requested"]),
    codeHash: z.string().length(64),
    checks: z.array(z.object({ probe: Str(80), description: Str(300), pass: z.boolean() })).min(1),
    findings: z.array(z.string()).max(20), // finding codes raised by this review
    unsupportedClaims: z.number().int().min(0),
  }),
  SECURITY_REVIEW: z.object({
    codeHash: z.string().length(64),
    checks: z.array(z.object({ check: Str(200), pass: z.boolean() })).min(1),
    findings: z.array(z.string()).max(20),
  }),
  APPROVAL: z.object({ approvalId: z.string().min(1), payloadHash: z.string().length(64) }),
  REPORT: z.object({ summary: Str(1500), unresolved: z.array(Str(400)).max(20) }),
} as const;

export type OutputKind = keyof typeof OUTPUT_SCHEMAS;
export const OUTPUT_KINDS = Object.keys(OUTPUT_SCHEMAS) as OutputKind[];

export type ValidationResult<T = unknown> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Validate a task's structured output. Unknown kinds are rejected, not passed through. */
export function validateOutput(kind: string, output: unknown): ValidationResult {
  const schema = (OUTPUT_SCHEMAS as Record<string, z.ZodTypeAny>)[kind];
  if (!schema) return { ok: false, errors: [`no output contract for task kind ${kind}`] };
  const r = schema.safeParse(output);
  return r.success ? { ok: true, value: r.data } : { ok: false, errors: r.error.errors.map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`) };
}

/**
 * Parse model text that is supposed to contain a JSON object. Tolerates a
 * surrounding code fence, nothing else. Returns null if no object parses.
 */
export function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handoff contract
// ---------------------------------------------------------------------------

export const HandoffSchema = z.object({
  missionId: z.string().min(1),
  taskKey: z.string().min(1),
  taskKind: z.string().min(1),
  runId: z.string().min(1),
  fromAgent: z.string().min(1),
  toAgents: z.array(z.string()),
  objective: Str(600),
  findings: z.array(Str(600)).max(20), // short, factual summaries
  decisions: z.array(Str(400)).max(20),
  artifacts: z.array(z.object({ id: z.string().min(1), kind: z.string(), name: z.string(), version: z.number().int() })).max(20),
  tests: z.array(TestEvidenceSchema).max(10),
  outstandingIssues: z.array(z.object({ code: z.string(), severity: z.string(), blocking: z.boolean(), title: z.string() })).max(20),
  risks: z.array(Str(400)).max(10),
  nextAction: Str(400),
  output: z.record(z.unknown()), // the validated structured output
  claims: z.string().max(2000).default(""), // agent narrative — NOT verified
});
export type Handoff = z.infer<typeof HandoffSchema>;

export function validateHandoff(h: unknown): ValidationResult<Handoff> {
  const r = HandoffSchema.safeParse(h);
  return r.success ? { ok: true, value: r.data } : { ok: false, errors: r.error.errors.map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`) };
}
