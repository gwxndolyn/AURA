/**
 * Project-scoped engineering memory (ProjectMemory rows).
 *
 * Every entry has provenance (which build / brief / approval / person produced
 * it), timestamps, the files and requirements it is about, and a status:
 *
 *   VERIFIED     backed by executed evidence (a passing engine check) or an
 *                explicit human approval
 *   ASSUMPTION   recorded but not proven (e.g. brief assumptions) — always
 *                labelled as such when shown to an agent
 *   STALE        a file or requirement it depends on changed after it was
 *                recorded; excluded from retrieval until re-verified
 *   INVALIDATED  contradicted by evidence or removed by a person
 *
 * Memory is written ONLY from recorded outcomes (never from free-form model
 * text), is always scoped by companyId + productId, and retrieval returns a
 * small, relevant, budgeted slice — never the whole history.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { parseJSON } from "@/lib/utils";
import { audit } from "@/lib/events/emit";
import { redact } from "@/lib/intelligence/redact";

export const MEMORY_KINDS = ["convention", "decision", "api_contract", "dependency", "defect_solution", "test_setup", "limitation", "approved_decision", "pattern"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_STATUSES = ["VERIFIED", "ASSUMPTION", "STALE", "INVALIDATED"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export interface Provenance { type: "build" | "brief" | "approval" | "user" | "repository"; ref: string; detail: string }

type Row = Awaited<ReturnType<typeof prisma.projectMemory.findFirst>> & {};

export function memoryView(m: NonNullable<Row>) {
  return { ...m, files: parseJSON<string[]>(m.files, []), requirements: parseJSON<string[]>(m.requirements, []), provenance: parseJSON<Provenance>(m.provenance, { type: "user", ref: "", detail: "" }) };
}

/**
 * Upsert by stable key. Re-recording an entry with new evidence refreshes it
 * (and re-verifies a STALE one); an INVALIDATED entry is only revived by a
 * person or by new VERIFIED evidence.
 */
export async function remember(args: { companyId: string; productId: string; key: string; kind: MemoryKind; content: string; status: "VERIFIED" | "ASSUMPTION"; files?: string[]; requirements?: string[]; sourceSha?: string | null; provenance: Provenance }) {
  const content = redact(args.content).slice(0, 1200);
  const data = { kind: args.kind, content, status: args.status, files: JSON.stringify((args.files ?? []).slice(0, 30)), requirements: JSON.stringify((args.requirements ?? []).slice(0, 20)), sourceSha: args.sourceSha ?? null, provenance: JSON.stringify(args.provenance), staleReason: "", verifiedAt: args.status === "VERIFIED" ? new Date() : null };
  const prior = await prisma.projectMemory.findUnique({ where: { productId_key: { productId: args.productId, key: args.key } } });
  if (prior && prior.companyId !== args.companyId) throw new ApiError("Memory scope mismatch", 403);
  if (prior?.status === "INVALIDATED" && args.status !== "VERIFIED") return prior;
  if (prior?.status === "VERIFIED" && args.status === "ASSUMPTION") return prior; // never downgrade proven knowledge by assertion
  return prisma.projectMemory.upsert({ where: { productId_key: { productId: args.productId, key: args.key } }, create: { companyId: args.companyId, productId: args.productId, key: args.key, ...data }, update: data });
}

/**
 * Mark memories that depend on changed files / requirements as STALE.
 * Called when verified code lands (changed files) and when the brief changes
 * (changed requirement ids). Returns the keys that became stale.
 */
export async function markStale(companyId: string, productId: string, change: { files?: string[]; requirements?: string[]; reason: string; exceptKeys?: string[] }) {
  const rows = await prisma.projectMemory.findMany({ where: { companyId, productId, status: { in: ["VERIFIED", "ASSUMPTION"] } } });
  const files = new Set(change.files ?? []);
  const reqs = new Set(change.requirements ?? []);
  const hit = rows.filter((r) => !(change.exceptKeys ?? []).includes(r.key) && (parseJSON<string[]>(r.files, []).some((f) => files.has(f)) || parseJSON<string[]>(r.requirements, []).some((q) => reqs.has(q))));
  if (hit.length) await prisma.projectMemory.updateMany({ where: { id: { in: hit.map((h) => h.id) } }, data: { status: "STALE", staleReason: change.reason.slice(0, 300) } });
  return hit.map((h) => h.key);
}

export async function setMemoryStatus(companyId: string, productId: string, id: string, actor: string, status: "VERIFIED" | "INVALIDATED", note = "") {
  const m = await prisma.projectMemory.findFirst({ where: { id, companyId, productId } });
  if (!m) throw new ApiError("Memory not found", 404);
  // A person confirming a fact is an explicit approval; it is recorded as such.
  const prov: Provenance = status === "VERIFIED" ? { type: "approval", ref: actor, detail: note || "confirmed by a person" } : parseJSON<Provenance>(m.provenance, { type: "user", ref: actor, detail: "" });
  const row = await prisma.projectMemory.update({ where: { id }, data: { status, staleReason: status === "INVALIDATED" ? (note || `invalidated by ${actor}`).slice(0, 300) : "", provenance: JSON.stringify(prov), verifiedAt: status === "VERIFIED" ? new Date() : m.verifiedAt, kind: status === "VERIFIED" && m.kind === "decision" ? "approved_decision" : m.kind } });
  await audit(companyId, actor, "PROJECT_MEMORY_STATUS", id, `${m.key}: ${m.status} → ${status}`);
  return memoryView(row);
}

export async function listMemory(companyId: string, productId: string) {
  const rows = await prisma.projectMemory.findMany({ where: { companyId, productId }, orderBy: [{ status: "asc" }, { updatedAt: "desc" }], take: 300 });
  return rows.map(memoryView);
}

/**
 * Relevant memory for one task, within a character budget. Ranking: entries
 * about the task's files / requirements first, then defect solutions for the
 * failures at hand, then conventions; VERIFIED before ASSUMPTION. STALE and
 * INVALIDATED entries are never returned.
 */
export async function retrieve(companyId: string, productId: string, q: { files?: string[]; requirements?: string[]; signatures?: string[]; text?: string; budgetChars?: number; limit?: number }) {
  const rows = await prisma.projectMemory.findMany({ where: { companyId, productId, status: { in: ["VERIFIED", "ASSUMPTION"] } }, take: 500 });
  const files = new Set(q.files ?? []);
  const reqs = new Set(q.requirements ?? []);
  const sigs = new Set(q.signatures ?? []);
  const terms = (q.text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 4);
  const scored = rows.map((r) => {
    const v = memoryView(r);
    let s = 0;
    if (v.files.some((f) => files.has(f))) s += 5;
    if (v.requirements.some((x) => reqs.has(x))) s += 4;
    if (v.kind === "defect_solution" && sigs.has(v.key.replace(/^defect:/, ""))) s += 8;
    if (["convention", "test_setup", "approved_decision", "dependency"].includes(v.kind)) s += 1.5;
    if (v.kind === "api_contract") s += 1;
    s += terms.reduce((a, t) => a + (v.content.toLowerCase().includes(t) ? 0.5 : 0), 0);
    if (v.status === "VERIFIED") s += 1;
    return { v, s };
  }).filter((x) => x.s > 1).sort((a, b) => b.s - a.s || +b.v.updatedAt - +a.v.updatedAt);
  const budget = q.budgetChars ?? 3500;
  const picked: ReturnType<typeof memoryView>[] = [];
  let used = 0;
  for (const { v } of scored) {
    if (picked.length >= (q.limit ?? 12)) break;
    if (used + v.content.length > budget) continue;
    picked.push(v);
    used += v.content.length;
  }
  if (picked.length) await prisma.projectMemory.updateMany({ where: { id: { in: picked.map((p) => p.id) } }, data: { uses: { increment: 1 } } });
  return picked;
}

/** Render retrieved memory for a prompt: facts and assumptions are labelled separately. */
export function renderMemory(items: ReturnType<typeof memoryView>[]) {
  if (!items.length) return "";
  const line = (m: ReturnType<typeof memoryView>) => `- [${m.kind}] ${m.content} (source: ${m.provenance.type} ${m.provenance.ref.slice(-8)}${m.verifiedAt ? `, verified ${m.verifiedAt.toISOString().slice(0, 10)}` : ""})`;
  const facts = items.filter((m) => m.status === "VERIFIED");
  const assumptions = items.filter((m) => m.status === "ASSUMPTION");
  return [
    "# Project memory (retrieved for this task)",
    facts.length ? `Verified facts (from executed evidence or approved by a person):\n${facts.map(line).join("\n")}` : "",
    assumptions.length ? `Assumptions (NOT verified — confirm in the code before relying on them):\n${assumptions.map(line).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}
