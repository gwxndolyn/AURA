/**
 * Feature contracts (AURA V10 §7): ONE structured record per story that the
 * PM, architect, designer, engineers and QA all work from, so agents do not
 * invent incompatible interpretations of the same feature.
 *
 * Built deterministically from persisted artifacts (no model call): the brief
 * (problem, journey, requirements), the story's tasks (acceptance, files,
 * kinds), the approved architecture (API operations, data model, rules) and
 * the approved design handoff (pages, states). Verification evidence is
 * attached from the tasks' VERIFIED builds. Stored as a versioned
 * FEATURE_CONTRACT artifact; when its inputs change, a new version is written
 * and the tasks that consumed the previous version are listed as affected.
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { createHash } from "node:crypto";

export interface FeatureContract {
  story: string;
  problem: string;
  behaviour: string[]; // expected user behaviour (journey steps)
  entryPoints: string[]; // pages / routes
  ui: string[]; // components from the design handoff
  api: { name: string; signature: string; rules: string[] }[];
  data: { entity: string; fields: string[] }[];
  authorization: string[];
  validation: string[];
  states: string[]; // loading / failure states
  acceptance: { text: string; task: string }[];
  tests: string[]; // test files that exercise the story (from verified builds)
  evidence: { task: string; build: string; status: string; summary: string }[];
  sources: string[]; // provenance of each part
}

type Item = { key: string; parentKey: string | null; level: string; kind: string; title: string; acceptance: string; files: string; requirements: string; status: string; buildId: string | null };

export function buildContract(story: Item, tasks: Item[], ctx: { brief: { problem?: string; journeys?: { name: string; steps: string[] }[]; functional?: { id: string; text: string }[]; nonFunctional?: { id: string; text: string }[]; coreJourney?: string } | null; arch: { contracts?: { name: string; signature: string; rules: string[] }[]; dataModel?: { entity: string; fields: string[] }[] } | null; design: { pages?: { id: string; title: string; states?: Record<string, string> }[]; components?: { name: string }[] } | null; builds: { id: string; itemKey: string; status: string; summary: string; changed: string }[] }): FeatureContract {
  const reqIds = new Set(tasks.flatMap((t) => parseJSON<string[]>(t.requirements, [])));
  const reqText = [...(ctx.brief?.functional ?? []), ...(ctx.brief?.nonFunctional ?? [])].filter((r) => reqIds.has(r.id)).map((r) => `${r.id}: ${r.text}`);
  const files = new Set(tasks.flatMap((t) => parseJSON<string[]>(t.files, [])));
  const allRules = (ctx.arch?.contracts ?? []).flatMap((c) => c.rules);
  const api = (ctx.arch?.contracts ?? []).filter((c) => tasks.some((t) => `${t.title} ${parseJSON<string[]>(t.acceptance, []).join(" ")}`.toLowerCase().includes(c.name.split(" ").pop()!.toLowerCase().replace(/[:{}]/g, ""))) || files.size === 0);
  const tests = [...new Set(ctx.builds.filter((b) => b.status === "VERIFIED").flatMap((b) => parseJSON<string[]>(b.changed, []).map((c) => c.replace(/^\w+\s+/, "")).filter((p) => /\.test\.[cm]?[jt]s$/.test(p))))];
  return {
    story: story.key,
    problem: ctx.brief?.problem ?? story.title,
    behaviour: ctx.brief?.coreJourney ? [ctx.brief.coreJourney, ...(ctx.brief.journeys?.[0]?.steps ?? [])] : (ctx.brief?.journeys?.[0]?.steps ?? [story.title]),
    entryPoints: (ctx.design?.pages ?? []).map((p) => `${p.title} (${p.id})`),
    ui: (ctx.design?.components ?? []).map((c) => c.name),
    api: api.map((c) => ({ name: c.name, signature: c.signature, rules: c.rules })),
    data: ctx.arch?.dataModel ?? [],
    authorization: [...reqText, ...allRules].filter((t) => /auth|permission|owner|role|only (the )?(user|admin)/i.test(t)),
    validation: [...reqText, ...allRules, ...tasks.flatMap((t) => parseJSON<string[]>(t.acceptance, []))].filter((t) => /valid|required|reject|400|422|must be|at least|positive|empty/i.test(t)).slice(0, 12),
    states: (ctx.design?.pages ?? []).flatMap((p) => Object.entries(p.states ?? {}).map(([k, v]) => `${p.title} ${k}: ${v}`)).slice(0, 12),
    acceptance: tasks.flatMap((t) => parseJSON<string[]>(t.acceptance, []).map((text) => ({ text, task: t.key }))),
    tests,
    evidence: tasks.map((t) => { const b = ctx.builds.find((x) => x.id === t.buildId); return { task: t.key, build: b?.id ?? "", status: t.status, summary: b?.summary.slice(0, 300) ?? "not built yet" }; }),
    sources: [ctx.brief ? "brief" : "", ctx.arch ? "architecture" : "", ctx.design ? "design handoff" : "", "backlog", ctx.builds.length ? "builds" : ""].filter(Boolean),
  };
}

const fingerprint = (c: FeatureContract) => createHash("sha256").update(JSON.stringify({ ...c, evidence: undefined, tests: undefined })).digest("hex").slice(0, 16);

/** (Re)compute contracts for every story; write a new version only when the definition (not evidence) changed. Returns stories whose contract changed and the tasks affected. */
export async function syncFeatureContracts(companyId: string, productId: string) {
  const [items, briefRow, archRow, designRow] = await Promise.all([
    prisma.backlogItem.findMany({ where: { productId, companyId, status: { not: "CANCELLED" } }, select: { key: true, parentKey: true, level: true, kind: true, title: true, acceptance: true, files: true, requirements: true, status: true, buildId: true } }),
    prisma.productBrief.findFirst({ where: { productId, companyId }, orderBy: { version: "desc" } }),
    prisma.productArtifact.findFirst({ where: { productId, companyId, kind: "ARCHITECTURE", status: "APPROVED" }, orderBy: { version: "desc" } }),
    prisma.productArtifact.findFirst({ where: { productId, companyId, kind: "HANDOFF", status: "APPROVED" }, orderBy: { version: "desc" } }),
  ]);
  const builds = await prisma.build.findMany({ where: { companyId, productId, id: { in: items.map((i) => i.buildId).filter(Boolean) as string[] } }, select: { id: true, itemKey: true, status: true, summary: true, changed: true } });
  const changed: { story: string; version: number; affected: string[] }[] = [];
  for (const story of items.filter((i) => i.level === "STORY")) {
    const tasks = items.filter((i) => i.parentKey === story.key && (i.level === "TASK" || i.level === "REPAIR"));
    if (!tasks.length) continue;
    const c = buildContract(story, tasks, { brief: briefRow ? parseJSON(briefRow.content, null) : null, arch: archRow ? parseJSON(archRow.content, null) : null, design: designRow ? parseJSON(designRow.content, null) : null, builds });
    const fp = fingerprint(c);
    const prev = await prisma.productArtifact.findFirst({ where: { productId, companyId, kind: "FEATURE_CONTRACT", title: { startsWith: `Feature ${story.key}:` } }, orderBy: { version: "desc" } });
    const prevFp = prev ? parseJSON<{ fingerprint?: string }>(prev.content, {}).fingerprint : null;
    if (prev && prevFp === fp) {
      await prisma.productArtifact.update({ where: { id: prev.id }, data: { content: JSON.stringify({ ...c, fingerprint: fp }) } }); // evidence refresh only
      continue;
    }
    const version = (prev?.version ?? 0) + 1;
    if (prev) await prisma.productArtifact.update({ where: { id: prev.id }, data: { status: "SUPERSEDED" } });
    await prisma.productArtifact.create({ data: { productId, companyId, kind: "FEATURE_CONTRACT", version, title: `Feature ${story.key}: ${story.title}`.slice(0, 120), content: JSON.stringify({ ...c, fingerprint: fp }), status: "APPROVED", source: "engine", producedBy: "product-manager", consumedBy: JSON.stringify(tasks.map((t) => t.key)), feedback: "[]" } });
    if (prev) changed.push({ story: story.key, version, affected: tasks.filter((t) => t.status === "VERIFIED").map((t) => t.key) });
  }
  return changed;
}
