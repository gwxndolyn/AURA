"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { CodeView } from "@/components/code/code-view";
import { cn, timeAgo } from "@/lib/utils";
import type { MissionArtifact } from "./types";

/** Label stating exactly how a test result was produced. */
export function ModeBadge({ mode }: { mode?: string }) {
  if (mode === "docker") return <Badge tone="success">executed · docker sandbox</Badge>;
  return <Badge tone="warning">not executed · {mode ?? "unknown"}</Badge>;
}

export function TestReport({ a }: { a: MissionArtifact }) {
  const cases = (a.meta.cases ?? []) as { name: string; ok: boolean }[];
  return (
    <div className="rounded-md border border-border" data-artifact="TEST_REPORT">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium">{a.name}</span>
        <ModeBadge mode={a.meta.mode} />
        <span className={cn("mono text-xs", a.meta.failed ? "text-danger" : "text-success")}>{a.meta.passed}/{a.meta.total} passed</span>
        {a.meta.durationMs != null && <span className="mono text-2xs text-text-faint">{a.meta.durationMs}ms</span>}
        <span className="mono ml-auto text-2xs text-text-faint">{timeAgo(a.createdAt)}</span>
      </div>
      <ul className="divide-y divide-border-subtle">
        {cases.map((c) => (
          <li key={c.name} className="flex items-center gap-2 px-3 py-1.5 text-xs">
            {c.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <XCircle className="h-3.5 w-3.5 text-danger" />}
            <span className={c.ok ? "text-text-muted" : "text-text"}>{c.name}</span>
          </li>
        ))}
      </ul>
      <details className="border-t border-border-subtle">
        <summary className="cursor-pointer px-3 py-1.5 text-2xs text-text-faint hover:text-text-muted">Raw runner output</summary>
        <pre className="well mono mx-3 mb-3 max-h-64 overflow-auto whitespace-pre-wrap p-2 text-2xs text-text-muted">{a.content}</pre>
      </details>
    </div>
  );
}

export function DiffView({ a }: { a: MissionArtifact }) {
  return (
    <div className="rounded-md border border-border" data-artifact="DIFF">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="mono text-sm">{a.name}</span>
        <span className="mono text-xs"><span className="text-success">+{a.meta.added}</span> <span className="text-danger">−{a.meta.removed}</span></span>
        {a.meta.change && <span className="text-xs text-text-muted">{a.meta.change}</span>}
        <Badge>{a.meta.author === "model-assisted" ? "model-assisted" : "prepared candidate (simulator)"}</Badge>
      </div>
      <pre className="mono max-h-[420px] overflow-auto py-2 text-xs leading-5">
        {a.content.split("\n").map((l, i) => (
          <div key={i} className={cn("px-3", l.startsWith("+ ") ? "bg-success/10 text-success" : l.startsWith("- ") ? "bg-danger/10 text-danger" : "text-text-muted")}>{l || " "}</div>
        ))}
      </pre>
    </div>
  );
}

export function SecurityReport({ a }: { a: MissionArtifact }) {
  const checks = (a.meta.checks ?? []) as { check: string; pass: boolean }[];
  return (
    <div className="rounded-md border border-border" data-artifact="SECURITY_REPORT">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium">{a.name}</span>
        <Badge>deterministic checks on the final code</Badge>
      </div>
      <ul className="divide-y divide-border-subtle">
        {checks.map((c) => (
          <li key={c.check} className="flex items-center gap-2 px-3 py-1.5 text-xs">
            {c.pass ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <XCircle className="h-3.5 w-3.5 text-danger" />}
            {c.check}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ArtifactView({ a }: { a: MissionArtifact }) {
  if (a.kind === "TEST_REPORT") return <TestReport a={a} />;
  if (a.kind === "DIFF") return <DiffView a={a} />;
  if (a.kind === "SECURITY_REPORT") return <SecurityReport a={a} />;
  if (a.kind === "FILE") return (
    <div className="rounded-md border border-border" data-artifact="FILE">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm"><span className="mono">{a.name}</span><span className="mono text-2xs text-text-faint">v{a.version}</span></div>
      <CodeView code={a.content} path={a.name} className="max-h-[420px]" />
    </div>
  );
  return (
    <div className="rounded-md border border-border" data-artifact={a.kind}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <span className="font-medium">{a.name}</span>
        <Badge>{a.meta.mode === "live" ? `model · ${a.meta.model}` : "simulator text"}</Badge>
      </div>
      <p className="whitespace-pre-wrap px-3 py-2 text-sm text-text-muted">{a.content}</p>
    </div>
  );
}
