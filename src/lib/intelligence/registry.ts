/**
 * Prompt registry with immutable versions.
 *
 * - A PromptTemplate is a stable identity (`key`), e.g. "agent.backend-engineer.system".
 * - A PromptVersion's content is NEVER updated. Editing = creating version N+1.
 *   `contentHash` (sha256 of content fields) lets anyone verify immutability.
 * - Only `status` moves through the lifecycle:
 *     DRAFT → EVALUATING → APPROVED → ACTIVE → DEPRECATED | ROLLED_BACK
 * - Exactly one ACTIVE version per template. Activation happens ONLY through
 *   promotion.ts (gated + audited) — this module does not expose a raw "activate".
 * - Every workspace starts with v1 of each agent's prompt imported from
 *   src/lib/agents/definitions.ts (source "builtin"), status ACTIVE, so runs are
 *   always attributable to a recorded version.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { AGENT_DEFS, getAgentDef } from "@/lib/agents/definitions";
import { libraryPrompt, PROMPT_LIBRARY_VERSION } from "@/lib/agents/prompts";
import { audit } from "@/lib/events/emit";

export const PROMPT_STATUSES = ["DRAFT", "EVALUATING", "APPROVED", "ACTIVE", "DEPRECATED", "ROLLED_BACK"] as const;
export type PromptStatus = (typeof PROMPT_STATUSES)[number];

/** Allowed lifecycle transitions (activation/rollback handled by promotion.ts). */
const TRANSITIONS: Record<PromptStatus, PromptStatus[]> = {
  DRAFT: ["EVALUATING", "DEPRECATED"],
  EVALUATING: ["APPROVED", "DRAFT", "DEPRECATED"],
  APPROVED: ["ACTIVE", "DEPRECATED"],
  ACTIVE: ["APPROVED", "DEPRECATED", "ROLLED_BACK"], // APPROVED = superseded by a newer promotion (rollback target)
  DEPRECATED: [],
  ROLLED_BACK: ["APPROVED"],
};

export function canTransition(from: PromptStatus, to: PromptStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function agentPromptKey(agentKey: string) {
  return `agent.${agentKey}.system`;
}

export interface VersionContent {
  content: string;
  inputVars: string[];
  outputContract: string;
  modelReqs: Record<string, unknown>;
  datasetId: string | null;
}

export function hashContent(c: VersionContent): string {
  return createHash("sha256")
    .update(JSON.stringify([c.content, c.inputVars, c.outputContract, c.modelReqs, c.datasetId]))
    .digest("hex");
}

/**
 * Idempotently import built-in agent prompts as v1 ACTIVE for a workspace.
 * For workspaces created before a prompt-library release, the new library
 * text is added once as a DRAFT version (never auto-activated): it is promoted
 * through the normal evaluate → approve → promote path, so a prompt change is
 * adopted only on evidence and the previous version stays available for rollback.
 */
export async function ensureBuiltinPrompts(companyId: string) {
  for (const def of AGENT_DEFS) {
    const key = agentPromptKey(def.key);
    const content: VersionContent = {
      content: def.systemPrompt,
      inputVars: ["company_state", "memory", "context", "objective"],
      outputContract: libraryPrompt(def.key) ? "Engineering agents: real tool use, then a final summary (implementers) or ONE review JSON object {verdict, criteria, findings, confidence, notVerified} (QA/security/reviewer), validated by the caller." : "Free text, or JSON matching the simulator `kind` contract when one is requested.",
      modelReqs: { minTier: def.tier },
      datasetId: def.key,
    };
    const existing = await prisma.promptTemplate.findUnique({ where: { companyId_key: { companyId, key } } });
    if (existing) {
      if (!libraryPrompt(def.key)) continue;
      const hash = hashContent(content);
      if (await prisma.promptVersion.findFirst({ where: { templateId: existing.id, contentHash: hash }, select: { id: true } })) continue;
      const last = await prisma.promptVersion.findFirst({ where: { templateId: existing.id }, orderBy: { version: "desc" }, select: { version: true } });
      await prisma.promptVersion.create({ data: { templateId: existing.id, companyId, version: (last?.version ?? 0) + 1, content: content.content, inputVars: JSON.stringify(content.inputVars), outputContract: content.outputContract, modelReqs: JSON.stringify(content.modelReqs), datasetId: content.datasetId, author: `library:${PROMPT_LIBRARY_VERSION}`, changelog: `Prompt library ${PROMPT_LIBRARY_VERSION} (src/lib/agents/prompts.ts): operational role card + shared engineering and security rules. Draft — evaluate before promoting.`, contentHash: hash, status: "DRAFT" } }).catch((e) => {
        if ((e as { code?: string }).code !== "P2002") throw e; // concurrent import
      });
      continue;
    }
    await prisma.promptTemplate.create({
      data: {
        companyId,
        key,
        agentKey: def.key,
        workflow: "agent.turn",
        purpose: `System prompt for ${def.name} (${def.role}).`,
        versions: {
          create: {
            companyId,
            version: 1,
            content: content.content,
            inputVars: JSON.stringify(content.inputVars),
            outputContract: content.outputContract,
            modelReqs: JSON.stringify(content.modelReqs),
            datasetId: content.datasetId,
            author: libraryPrompt(def.key) ? `library:${PROMPT_LIBRARY_VERSION}` : "builtin:definitions.ts",
            changelog: libraryPrompt(def.key) ? `Imported from the prompt library ${PROMPT_LIBRARY_VERSION} (src/lib/agents/prompts.ts)` : "Imported from src/lib/agents/definitions.ts",
            contentHash: hashContent(content),
            status: "ACTIVE",
            activatedAt: new Date(),
          },
        },
      },
    });
  }
}

/** Create a NEW immutable version (status DRAFT). Never modifies prior versions. */
export async function createVersion(args: {
  companyId: string;
  templateKey: string;
  content: string;
  changelog: string;
  author: string;
  outputContract?: string;
  inputVars?: string[];
  modelReqs?: Record<string, unknown>;
  datasetId?: string | null;
}) {
  await ensureBuiltinPrompts(args.companyId);
  const template = await prisma.promptTemplate.findUnique({
    where: { companyId_key: { companyId: args.companyId, key: args.templateKey } },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  if (!template) throw new Error(`Unknown prompt template: ${args.templateKey}`);
  const prev = template.versions[0];
  const content: VersionContent = {
    content: args.content,
    inputVars: args.inputVars ?? (prev ? JSON.parse(prev.inputVars) : []),
    outputContract: args.outputContract ?? prev?.outputContract ?? "",
    modelReqs: args.modelReqs ?? (prev ? JSON.parse(prev.modelReqs) : {}),
    datasetId: args.datasetId !== undefined ? args.datasetId : prev?.datasetId ?? null,
  };
  const hash = hashContent(content);
  if (prev && prev.contentHash === hash) throw new Error("Candidate is identical to the latest version");

  const v = await prisma.promptVersion.create({
    data: {
      templateId: template.id,
      companyId: args.companyId,
      version: (prev?.version ?? 0) + 1,
      content: content.content,
      inputVars: JSON.stringify(content.inputVars),
      outputContract: content.outputContract,
      modelReqs: JSON.stringify(content.modelReqs),
      datasetId: content.datasetId,
      author: args.author,
      changelog: args.changelog,
      contentHash: hash,
      status: "DRAFT",
    },
  });
  await audit(args.companyId, args.author, "PROMPT_VERSION_CREATED", `${args.templateKey}@v${v.version}`, args.changelog.slice(0, 200));
  return v;
}

/** Status-only lifecycle change (not activation — see promotion.ts). */
export async function setStatus(companyId: string, versionId: string, to: PromptStatus, actor: string) {
  const v = await prisma.promptVersion.findFirst({ where: { id: versionId, companyId } });
  if (!v) throw new Error("Prompt version not found");
  if (to === "ACTIVE" || to === "ROLLED_BACK") throw new Error("Use promotion to activate or roll back");
  if (!canTransition(v.status as PromptStatus, to)) throw new Error(`Illegal transition ${v.status} → ${to}`);
  const updated = await prisma.promptVersion.update({ where: { id: v.id }, data: { status: to } });
  await audit(companyId, actor, "PROMPT_STATUS", versionId, `${v.status} → ${to}`);
  return updated;
}

export async function getActiveVersion(companyId: string, templateKey: string) {
  const t = await prisma.promptTemplate.findUnique({ where: { companyId_key: { companyId, key: templateKey } } });
  if (!t) return null;
  return prisma.promptVersion.findFirst({ where: { templateId: t.id, status: "ACTIVE" } });
}

/** The system prompt an agent should use right now + the ref to record on AgentRun. */
export async function resolveAgentPrompt(companyId: string, agentKey: string): Promise<{ system: string; promptVersionId: string | null; promptRef: string }> {
  const def = getAgentDef(agentKey);
  const active = await getActiveVersion(companyId, agentPromptKey(agentKey)).catch(() => null);
  if (active) return { system: active.content, promptVersionId: active.id, promptRef: `${agentPromptKey(agentKey)}@v${active.version}` };
  return { system: def?.systemPrompt ?? "", promptVersionId: null, promptRef: `builtin:${agentKey}${libraryPrompt(agentKey) ? `@${PROMPT_LIBRARY_VERSION}` : ""}` };
}

export async function listTemplates(companyId: string) {
  await ensureBuiltinPrompts(companyId);
  return prisma.promptTemplate.findMany({
    where: { companyId },
    include: { versions: { orderBy: { version: "desc" } } },
    orderBy: { key: "asc" },
  });
}

/** Verify a stored version's content still matches its hash (immutability check). */
export function verifyIntegrity(v: { content: string; inputVars: string; outputContract: string; modelReqs: string; datasetId: string | null; contentHash: string }): boolean {
  return (
    hashContent({
      content: v.content,
      inputVars: JSON.parse(v.inputVars),
      outputContract: v.outputContract,
      modelReqs: JSON.parse(v.modelReqs),
      datasetId: v.datasetId,
    }) === v.contentHash
  );
}
