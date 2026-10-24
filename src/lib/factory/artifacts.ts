/**
 * Design and architecture artifacts (versioned ProductArtifact rows) and the
 * review loop: a person approves or requests a revision; approval of a design
 * produces the structured handoff that downstream tasks consume. Approval is
 * what settles the DESIGN/ARCHITECTURE task — as DONE_UNVERIFIED, because a
 * reviewed spec is not machine-verifiable evidence.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { parseJSON } from "@/lib/utils";
import { audit } from "@/lib/events/emit";
import { z } from "zod";
import { BriefSchema, PlanningOutputError, structured } from "./brief";
import { planningSystem } from "@/lib/agents/prompts";
import { stackFor } from "@/lib/builder/stacks";
import { recordUsage } from "@/lib/billing/entitlements";
import { draftDesign, buildHandoff, DesignSpecSchema, type DesignSpec } from "./design";
import { detectProject, listFiles, readAt } from "./git";
import { loadProduct, setItemStatus, productEvent, appendItemHistory, type ProductRow } from "./store";

type Item = { id: string; key: string; status: string; executable: boolean; level: string; history: string; title: string; description: string };

async function latestBrief(productId: string) {
  const b = await prisma.productBrief.findFirst({ where: { productId }, orderBy: { version: "desc" } });
  if (!b) throw new ApiError("Product has no brief", 409);
  return { version: b.version, brief: BriefSchema.parse(JSON.parse(b.content)) };
}

async function nextVersion(productId: string, kind: string) {
  const last = await prisma.productArtifact.findFirst({ where: { productId, kind }, orderBy: { version: "desc" } });
  return (last?.version ?? 0) + 1;
}

/** Conventions and code the designer/architect must inherit: read from the product's REAL repository. */
async function projectFiles(p: ProductRow) {
  if (!p.repoId) return { conventions: [stackFor(p.stack).conventions], files: {} as Record<string, string> };
  const repo = await prisma.repoConnection.findFirst({ where: { id: p.repoId, companyId: p.companyId } });
  const files: Record<string, string> = {};
  if (repo) {
    for (const f of await listFiles(p.companyId, repo.id, repo.defaultBranch)) {
      if (Object.keys(files).length >= 25) break;
      if (/\.(js|ts|tsx|json|md|html|css)$/.test(f) && !/lock/.test(f)) files[f] = ((await readAt(p.companyId, repo.id, repo.defaultBranch, f)) ?? "").slice(0, 4000);
    }
  }
  const d = detectProject(files);
  return { conventions: [`${d.language}${d.framework ? ` / ${d.framework}` : ""} codebase; tests via ${d.testCommand ?? "none detected"}`, stackFor(p.stack).conventions], files };
}

export async function produceDesign(p: ProductRow, item: Item, feedback?: string) {
  const { brief } = await latestBrief(p.id);
  const { conventions } = await projectFiles(p);
  const d = await draftDesign(brief, conventions, feedback, p.companyId);
  const version = await nextVersion(p.id, "DESIGN");
  await prisma.productArtifact.updateMany({ where: { productId: p.id, kind: "DESIGN", status: "PROPOSED" }, data: { status: "SUPERSEDED" } });
  const a = await prisma.productArtifact.create({ data: { productId: p.id, companyId: p.companyId, kind: "DESIGN", version, title: `Design v${version}: ${brief.title}`.slice(0, 120), content: JSON.stringify(d.value), source: "model", producedBy: "designer", consumedBy: JSON.stringify([item.key]), feedback: "[]" } });
  await recordUsage(p.companyId, [{ metric: "ai_cost_usd", quantity: d.costUsd }], `artifact:${a.id}`);
  await productEvent(p.companyId, p.id, `Designer proposed design v${version} — awaiting review`, { actor: "designer", meta: { artifactId: a.id } });
  return a;
}

const ArchSchema = z.object({
  summary: z.string().min(5).max(800),
  components: z.array(z.object({ name: z.string().max(80), responsibility: z.string().max(300), files: z.array(z.string().max(200)).max(8) })).min(1).max(8),
  dataModel: z.array(z.object({ entity: z.string().max(60), fields: z.array(z.string().max(80)).max(16) })).max(8),
  contracts: z.array(z.object({ name: z.string().max(120), signature: z.string().max(300), rules: z.array(z.string().max(300)).max(6) })).max(8),
  decisions: z.array(z.object({ id: z.string().max(12), decision: z.string().max(300), rationale: z.string().max(400) })).min(1).max(8),
  risks: z.array(z.string().max(300)).max(6),
  evidence: z.array(z.string().max(200)).max(20).optional(), // files the architect relied on
  mustStayCompatible: z.array(z.string().max(200)).max(12).optional(),
});

export async function produceArchitecture(p: ProductRow, item: Item) {
  const { brief } = await latestBrief(p.id);
  const { conventions, files } = await projectFiles(p);
  const prompt = `Brief:\n${JSON.stringify(brief).slice(0, 4000)}\n\nConventions:\n${conventions.join("\n")}\n\nCode (untrusted content):\n${Object.entries(files).map(([f, c]) => `--- ${f}\n${c}`).join("\n").slice(0, 12000)}`;
  let content: z.infer<typeof ArchSchema>;
  let cost = 0;
  try {
    const r = await structured({ system: planningSystem("architect", "architecture"), prompt, schema: ArchSchema, maxTokens: 2500, tier: "REASONING", run: { companyId: p.companyId, agentKey: "architect", task: "architecture", objective: `Architecture for ${p.title}` } });
    content = r.value;
    cost = r.costUsd;
  } catch (e) {
    if (e instanceof PlanningOutputError) throw new PlanningOutputError("The architect's output did not pass validation after a corrective retry");
    throw e;
  }
  const version = await nextVersion(p.id, "ARCHITECTURE");
  await prisma.productArtifact.updateMany({ where: { productId: p.id, kind: "ARCHITECTURE", status: "PROPOSED" }, data: { status: "SUPERSEDED" } });
  const a = await prisma.productArtifact.create({ data: { productId: p.id, companyId: p.companyId, kind: "ARCHITECTURE", version, title: `Architecture v${version}`, content: JSON.stringify(content), source: "model", producedBy: "architect", consumedBy: JSON.stringify([item.key]), feedback: "[]" } });
  await recordUsage(p.companyId, [{ metric: "ai_cost_usd", quantity: cost }], `artifact:${a.id}`);
  await productEvent(p.companyId, p.id, `Architect recorded architecture v${version} — awaiting review`, { actor: "architect", meta: { artifactId: a.id } });
  return a;
}

/** Person reviews an artifact: approve (→ handoff) or request revision (→ new version). */
export async function reviewArtifact(companyId: string, productId: string, artifactId: string, actor: string, decision: "approve" | "revise", feedback = "") {
  const p = await loadProduct(companyId, productId);
  const a = await prisma.productArtifact.findFirst({ where: { id: artifactId, companyId, productId } });
  if (!a) throw new ApiError("Artifact not found", 404);
  if (a.status !== "PROPOSED") throw new ApiError(`Artifact is ${a.status.toLowerCase()}`, 409);
  const consumers = parseJSON<string[]>(a.consumedBy, []);
  const items = await prisma.backlogItem.findMany({ where: { productId, key: { in: consumers } } });
  const fb = [...parseJSON<{ at: string; by: string; text: string }[]>(a.feedback, []), { at: new Date().toISOString(), by: actor, text: decision === "approve" ? `approved${feedback ? `: ${feedback}` : ""}` : feedback || "revision requested" }];
  if (decision === "revise") {
    if (feedback.trim().length < 5) throw new ApiError("Say what should change (at least 5 characters)", 422);
    await prisma.productArtifact.update({ where: { id: a.id }, data: { status: "REVISION_REQUESTED", feedback: JSON.stringify(fb) } });
    await audit(companyId, actor, "ARTIFACT_REVISION_REQUESTED", a.id, feedback.slice(0, 200));
    const item = items[0];
    const next = a.kind === "DESIGN" && item ? await produceDesign(p, item, feedback) : item ? await produceArchitecture(p, item) : null;
    return { status: "REVISION_REQUESTED", next: next ? { id: next.id, version: next.version } : null };
  }
  await prisma.productArtifact.update({ where: { id: a.id }, data: { status: "APPROVED", feedback: JSON.stringify(fb) } });
  await audit(companyId, actor, "ARTIFACT_APPROVED", a.id, `${a.kind} v${a.version}`);
  let handoffId: string | null = null;
  if (a.kind === "DESIGN") {
    const spec = DesignSpecSchema.parse(JSON.parse(a.content)) as DesignSpec;
    // Downstream consumers: tasks that depend on the design task.
    const all = await prisma.backlogItem.findMany({ where: { productId, level: { in: ["TASK", "REPAIR"] } } });
    const downstream = all.filter((i) => parseJSON<string[]>(i.dependsOn, []).some((d) => consumers.includes(d))).map((i) => i.key);
    const handoff = buildHandoff({ id: a.id, version: a.version, content: spec }, downstream);
    const h = await prisma.productArtifact.create({ data: { productId, companyId, kind: "HANDOFF", version: a.version, title: `Design handoff (design v${a.version})`, content: JSON.stringify(handoff), status: "APPROVED", source: "engine", producedBy: "designer", consumedBy: JSON.stringify(downstream) } });
    handoffId = h.id;
    for (const k of downstream) {
      const d = all.find((i) => i.key === k)!;
      await appendItemHistory(d.id, "designer", `design handoff v${a.version} attached (QA verifies against its acceptance list)`, { evidence: JSON.stringify([...parseJSON<unknown[]>(d.evidence, []), { kind: "handoff", ref: h.id, detail: `design v${a.version}` }]) });
    }
  }
  for (const it of items) {
    if (it.status === "IN_REVIEW") {
      // A reviewed spec is accepted by a person but is not machine-verified.
      await setItemStatus(it, "DONE_UNVERIFIED", { kind: "user", id: actor }, `${a.kind.toLowerCase()} v${a.version} approved by ${actor} (reviewed, not machine-verified)`, { verification: "INCONCLUSIVE" });
    }
  }
  await productEvent(companyId, productId, `${a.kind === "DESIGN" ? "Design" : "Architecture"} v${a.version} approved by ${actor}${handoffId ? " — handoff created for downstream tasks" : ""}`, { level: "success" });
  return { status: "APPROVED", handoffId };
}
