/**
 * Project file service.
 *
 * The project is the workspace's existing CodeWorkspace row (files JSON = the
 * current revision). Every write goes through `applyWrites`, which:
 *   - validates each path (paths.ts) and the size/protection policy
 *   - checks each file's expected revision (optimistic concurrency — a stale
 *     writer gets a ConflictError naming the files, nothing is written)
 *   - applies ALL files or NONE (single compare-and-set on the workspace row)
 *   - bumps the project revision and records one immutable FileVersion per file
 * History is the FileVersion table; it is AURA's version-control format here
 * because project content lives in the database, not in a git checkout.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { emitEvent } from "@/lib/events/emit";
import { normalizePath, assertWritable, isProtected, MAX_FILES, PathError } from "./paths";

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export class ConflictError extends Error {
  constructor(public conflicts: { path: string; expected: number; actual: number }[]) {
    super(`File changed since you opened it: ${conflicts.map((c) => `${c.path} (yours r${c.expected}, current r${c.actual})`).join(", ")}`);
    this.name = "ConflictError";
  }
}

export type Ws = NonNullable<Awaited<ReturnType<typeof prisma.codeWorkspace.findFirst>>>;

export async function getWorkspace(companyId: string): Promise<Ws> {
  const ws = await prisma.codeWorkspace.findFirst({ where: { companyId }, orderBy: { updatedAt: "asc" } });
  if (ws) return ws;
  return prisma.codeWorkspace.create({ data: { companyId, name: "project" } });
}

export function filesOf(ws: Ws): Record<string, string> {
  return parseJSON<Record<string, string>>(ws.files, {});
}
export function revsOf(ws: Ws): Record<string, number> {
  return parseJSON<Record<string, number>>(ws.fileRevs, {});
}

export interface TreeEntry {
  path: string;
  size: number;
  rev: number;
  protected: boolean;
}

export function listTree(ws: Ws): TreeEntry[] {
  const files = filesOf(ws);
  const revs = revsOf(ws);
  return Object.keys(files)
    .sort()
    .map((p) => ({ path: p, size: Buffer.byteLength(files[p], "utf8"), rev: revs[p] ?? 0, protected: isProtected(p) }));
}

export function readFile(ws: Ws, rawPath: string): { path: string; content: string; rev: number; sha256: string } | null {
  const path = normalizePath(rawPath);
  const files = filesOf(ws);
  if (!(path in files)) return null;
  return { path, content: files[path], rev: revsOf(ws)[path] ?? 0, sha256: sha(files[path]) };
}

export interface WriteOp {
  path: string;
  content: string | null; // null = delete
  expectedRev: number; // 0 = must not exist yet
  changeId?: string;
}

/**
 * All-or-nothing write of several files. Throws ConflictError (nothing
 * written) if any file's revision moved, PathError on policy violations.
 */
export async function applyWrites(companyId: string, ops: WriteOp[], author: string, opts: { reason?: string } = {}) {
  if (!ops.length) throw new PathError("Nothing to write");
  for (let attempt = 0; attempt < 3; attempt++) {
    const ws = await getWorkspace(companyId);
    const files = filesOf(ws);
    const revs = revsOf(ws);
    const normalized = ops.map((o) => ({ ...o, path: normalizePath(o.path) }));
    const conflicts = normalized
      .map((o) => ({ path: o.path, expected: o.expectedRev, actual: o.path in files ? revs[o.path] ?? 0 : 0 }))
      .filter((c) => c.expected !== c.actual);
    if (conflicts.length) throw new ConflictError(conflicts);
    for (const o of normalized) if (o.content !== null) assertWritable(o.path, o.content);
    else if (!(o.path in files)) throw new PathError(`${o.path} does not exist`);

    const nextFiles = { ...files };
    const nextRevs = { ...revs };
    const revision = ws.revision + 1;
    for (const o of normalized) {
      if (o.content === null) delete nextFiles[o.path];
      else nextFiles[o.path] = o.content;
      nextRevs[o.path] = (revs[o.path] ?? 0) + 1;
    }
    if (Object.keys(nextFiles).length > MAX_FILES) throw new PathError(`Project would exceed ${MAX_FILES} files`);

    // Compare-and-set on the project revision: a concurrent writer makes this update match 0 rows.
    const res = await prisma.codeWorkspace.updateMany({ where: { id: ws.id, revision: ws.revision }, data: { files: JSON.stringify(nextFiles), fileRevs: JSON.stringify(nextRevs), revision } });
    if (res.count !== 1) continue; // another write landed between read and write: re-check per-file revisions
    await prisma.fileVersion.createMany({
      data: normalized.map((o) => ({
        workspaceId: ws.id,
        companyId,
        path: o.path,
        revision,
        fileRev: nextRevs[o.path],
        op: o.content === null ? "delete" : o.path in files ? "modify" : "create",
        content: o.content ?? "",
        sha256: sha(o.content ?? ""),
        author,
        changeId: o.changeId ?? null,
      })),
    });
    await emitEvent({ companyId, type: "CODE_CHANGED", actor: author.includes("@") ? "system" : author, message: `${author} ${opts.reason ?? "updated"} ${normalized.map((o) => o.path).join(", ")} (r${revision})`, meta: { revision, paths: normalized.map((o) => o.path) } });
    return { revision, files: normalized.map((o) => ({ path: o.path, rev: nextRevs[o.path] })) };
  }
  throw new ConflictError(ops.map((o) => ({ path: o.path, expected: o.expectedRev, actual: -1 })));
}

/** Ensure the original (pre-history) content is recoverable: record revision-0 versions once. */
export async function ensureBaseline(companyId: string) {
  const ws = await getWorkspace(companyId);
  if ((await prisma.fileVersion.count({ where: { workspaceId: ws.id } })) > 0) return ws;
  const files = filesOf(ws);
  if (!Object.keys(files).length) return ws;
  await prisma.fileVersion.createMany({ data: Object.entries(files).map(([path, content]) => ({ workspaceId: ws.id, companyId, path, revision: ws.revision, fileRev: revsOf(ws)[path] ?? 0, op: "create", content, sha256: sha(content), author: "baseline" })) });
  return ws;
}

export async function fileHistory(companyId: string, rawPath: string) {
  const ws = await getWorkspace(companyId);
  const path = normalizePath(rawPath);
  return prisma.fileVersion.findMany({ where: { workspaceId: ws.id, companyId, path }, orderBy: { revision: "desc" }, take: 50, select: { id: true, revision: true, fileRev: true, op: true, sha256: true, author: true, changeId: true, createdAt: true } });
}
