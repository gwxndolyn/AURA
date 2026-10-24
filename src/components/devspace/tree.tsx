"use client";

import { useMemo, useState } from "react";
import { ChevronRight, FileCode2, FileText, Folder, Lock, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface FileEntry {
  path: string;
  size: number;
  rev: number;
  protected: boolean;
}

interface Node {
  name: string;
  path: string;
  entry?: FileEntry;
  children?: Node[];
}

function buildTree(files: FileEntry[]): Node[] {
  const root: Node = { name: "", path: "", children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      const leaf = i === parts.length - 1;
      node.children ??= [];
      let child = node.children.find((c) => c.name === part && !!c.children === !leaf);
      if (!child) {
        child = leaf ? { name: part, path, entry: f } : { name: part, path, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (n: Node[]): Node[] => n.sort((a, b) => Number(!a.children) - Number(!b.children) || a.name.localeCompare(b.name)).map((c) => (c.children ? { ...c, children: sort(c.children) } : c));
  return sort(root.children ?? []);
}

const PAGE = 200; // render at most this many entries per folder before "show more"

/**
 * Project explorer: real project paths only (from the workspace API), folders
 * collapsible, search filters to matching files and expands their folders.
 */
export function FileTree({ files, active, changed, onOpen }: { files: FileEntry[]; active: string | null; changed: Set<string>; onOpen: (path: string) => void }) {
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [more, setMore] = useState<Set<string>>(new Set());
  const shown = useMemo(() => (q ? files.filter((f) => f.path.toLowerCase().includes(q.toLowerCase())) : files), [files, q]);
  const tree = useMemo(() => buildTree(shown), [shown]);
  const toggle = (p: string) => setCollapsed((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });

  const render = (nodes: Node[], depth: number, parent: string): React.ReactNode => {
    const limit = more.has(parent) ? nodes.length : PAGE;
    return (
      <ul role={depth ? "group" : "tree"} aria-label={depth ? undefined : "Project files"}>
        {nodes.slice(0, limit).map((n) =>
          n.children ? (
            <li key={n.path} role="treeitem" aria-selected={false} aria-expanded={q ? true : !collapsed.has(n.path)}>
              <button onClick={() => toggle(n.path)} className="flex h-6 w-full items-center gap-1 rounded px-1 text-left text-xs text-text-muted hover:bg-bg-elevated" style={{ paddingLeft: 4 + depth * 12 }}>
                <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", (q || !collapsed.has(n.path)) && "rotate-90")} />
                <Folder className="h-3.5 w-3.5 shrink-0 text-text-faint" />
                <span className="mono truncate">{n.name}</span>
              </button>
              {(q || !collapsed.has(n.path)) && render(n.children, depth + 1, n.path)}
            </li>
          ) : (
            <li key={n.path} role="treeitem" aria-selected={active === n.path}>
              <button onClick={() => onOpen(n.path)} title={n.path} data-path={n.path} className={cn("flex h-6 w-full items-center gap-1.5 rounded px-1 text-left text-xs", active === n.path ? "bg-bg-hover text-text" : "text-text-muted hover:bg-bg-elevated hover:text-text")} style={{ paddingLeft: 20 + depth * 12 }}>
                {n.name.endsWith(".md") ? <FileText className="h-3.5 w-3.5 shrink-0 text-text-faint" /> : <FileCode2 className="h-3.5 w-3.5 shrink-0 text-text-faint" />}
                <span className="mono truncate">{n.name}</span>
                {n.entry?.protected && <Lock className="ml-auto h-3 w-3 text-text-faint" aria-label="protected" />}
                {changed.has(n.path) && <span className="mono ml-auto text-2xs text-warning" title="Has a pending agent change">M</span>}
              </button>
            </li>
          ),
        )}
        {nodes.length > limit && (
          <li><button onClick={() => setMore((s) => new Set(s).add(parent))} className="mono px-2 py-1 text-2xs text-text-faint hover:text-text" style={{ paddingLeft: 20 + depth * 12 }}>+ {nodes.length - limit} more</button></li>
        )}
      </ul>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <label className="relative m-2 block">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-faint" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find file" aria-label="Find file" className="input h-7 pl-6 text-xs" />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {shown.length === 0 ? <p className="px-2 py-3 text-xs text-text-muted">{files.length ? "No file matches." : "This project has no files yet."}</p> : render(tree, 0, "")}
      </div>
    </div>
  );
}
