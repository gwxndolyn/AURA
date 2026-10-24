"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useQuery } from "@/hooks/useApi";
import { Skeleton, ErrorState } from "@/components/ui/primitives";
import { cn, timeAgo } from "@/lib/utils";

interface Health {
  overall: string;
  checks: Record<string, { status: string; detail?: string; latencyMs?: number }>;
  stats: { companies: number; agentRuns: number; toolCalls: number };
  ts: string;
}

/** What each probe status means for an operator. */
const STATUS: Record<string, { label: string; dot: string; note: string }> = {
  HEALTHY: { label: "healthy", dot: "bg-success", note: "" },
  SIMULATION: { label: "fallback", dot: "bg-warning", note: "running on the documented local fallback" },
  IN_MEMORY: { label: "in-memory", dot: "bg-info", note: "single-process mode" },
  CONFIGURED: { label: "configured", dot: "bg-info", note: "" },
  DEGRADED: { label: "degraded", dot: "bg-warning", note: "" },
  DOWN: { label: "down", dot: "bg-danger", note: "" },
};

const LABEL: Record<string, string> = {
  database: "Database",
  claude: "Model provider (Claude)",
  sandbox: "Code sandbox (Docker)",
  redis: "Event bus / Redis",
  eventStream: "Event stream (SSE)",
  cyberRange: "Cyber range",
};

export default function HealthPage() {
  const { data, loading, error, refetch } = useQuery<Health>("/api/health", 5000);
  const overall = STATUS[data?.overall ?? ""] ?? STATUS.DEGRADED;

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex h-14 max-w-[880px] items-center justify-between px-6">
        <Link href="/app" className="btn-ghost -ml-3">
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </Link>
        {data && <span className="mono text-2xs text-text-faint">probed {timeAgo(data.ts)} · refreshes every 5s</span>}
      </header>

      <main className="mx-auto max-w-[880px] px-6 py-6">
        <div className="page-header">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="page-title">System status</h1>
              {data && (
                <span className="inline-flex items-center gap-1.5 text-sm text-text-muted">
                  <span className={cn("dot", overall.dot)} />
                  {data.overall === "HEALTHY" ? "all systems operational" : overall.label}
                </span>
              )}
            </div>
            <p className="page-desc">Each subsystem is probed server-side on request: the database is queried, Docker is contacted, configuration is read.</p>
          </div>
        </div>

        {error && !data ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : loading && !data ? (
          <div className="space-y-1">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : data ? (
          <>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {Object.entries(data.checks).map(([key, c]) => {
                const s = STATUS[c.status] ?? STATUS.DEGRADED;
                return (
                  <li key={key} className="flex items-center gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">{LABEL[key] ?? key}</div>
                      <div className="text-xs text-text-muted">{c.detail}{s.note && <span className="text-text-faint"> · {s.note}</span>}</div>
                    </div>
                    {c.latencyMs != null && <span className="mono text-2xs text-text-faint">{c.latencyMs}ms</span>}
                    <span className="inline-flex w-28 items-center gap-1.5 text-xs text-text-muted"><span className={cn("dot", s.dot)} />{s.label}</span>
                  </li>
                );
              })}
            </ul>
            <dl className="mt-5 grid grid-cols-3 divide-x divide-border rounded-lg border border-border">
              {[["Companies", data.stats.companies], ["Agent runs", data.stats.agentRuns], ["Tool calls", data.stats.toolCalls]].map(([k, v]) => (
                <div key={k as string} className="px-4 py-3">
                  <dt className="metric-label">{k}</dt>
                  <dd className="mono mt-1 text-lg">{(v as number).toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : null}
      </main>
    </div>
  );
}
