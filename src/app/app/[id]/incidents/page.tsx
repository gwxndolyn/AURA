"use client";

import { use, useState } from "react";
import { ShieldAlert, Swords, Loader2, Play } from "lucide-react";
import { useQuery, useMutation } from "@/hooks/useApi";
import { StatusBadge, EmptyState, ErrorState, Skeleton, PageHeader, SimulatedNotice } from "@/components/ui/primitives";
import { IncidentReplay } from "@/components/cyber/incident-replay";
import { cn, timeAgo, parseJSON } from "@/lib/utils";
import { useApp } from "@/lib/store";

interface Incident {
  id: string;
  number: number;
  title: string;
  severity: string;
  status: string;
  attackType: string | null;
  target: string | null;
  summary: string;
  timeline: string;
  evidence: string;
  detectedAt: string;
  resolvedAt: string | null;
}

interface Finding {
  id: string;
  code: string;
  title: string;
  category: string;
  severity: string;
  status: string;
  affected: string;
  cvss: number;
  discoveredBy: string;
  createdAt: string;
}

interface Findings {
  findings: Finding[];
  security: { total: number; categories: { key: string; label: string; score: number; evidence: string }[] };
}

const SEV_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function duration(a: string, b: string | null) {
  if (!b) return "ongoing";
  const s = Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 1000);
  return s < 120 ? `${Math.round(s)}s` : `${Math.round(s / 60)}m`;
}

export default function IncidentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: incidents, loading, error, refetch } = useQuery<Incident[]>(`/api/companies/${id}/incidents`, 5000);
  const { data: fx, refetch: refetchFindings } = useQuery<Findings>(`/api/companies/${id}/findings`, 8000);
  const { mutate, loading: running } = useMutation();
  const { toast } = useApp();
  const [replay, setReplay] = useState<Incident | null>(null);
  const [tab, setTab] = useState<"incidents" | "findings">("incidents");

  async function simulate() {
    try {
      await mutate(`/api/companies/${id}/attack`, {});
      refetch();
      refetchFindings();
      toast({ title: "Simulated incident recorded", level: "success" });
    } catch (e) {
      toast({ title: "Simulation failed", description: (e as Error).message, level: "danger" });
    }
  }

  const open = fx?.findings.filter((f) => f.status === "OPEN" || f.status === "PATCHING") ?? [];
  const active = incidents?.filter((i) => i.status !== "RESOLVED") ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Incidents"
        description="Security incidents and findings produced by cyber-range exercises, with response timelines."
        actions={
          <button onClick={simulate} disabled={running} className="btn-secondary">
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Swords className="h-3.5 w-3.5" />}
            Simulate incident
          </button>
        }
      />
      <div className="mb-4"><SimulatedNotice>All incidents and findings below come from the isolated simulation, not real infrastructure.</SimulatedNotice></div>

      {/* Posture strip, derived from computeSecurityScore */}
      {fx && (
        <div className="mb-5 overflow-x-auto rounded-lg border border-border">
          <div className="flex min-w-[860px] divide-x divide-border">
            <div className="w-36 shrink-0 px-3 py-2.5">
              <div className="metric-label">Security score</div>
              <div className="mono mt-1 text-lg">{fx.security.total}<span className="text-xs text-text-faint">/100</span></div>
              <div className="text-2xs text-text-faint">{open.length} open · {active.length} active incidents</div>
            </div>
            {fx.security.categories.map((c) => (
              <div key={c.key} className="min-w-0 flex-1 px-3 py-2.5" title={c.evidence}>
                <div className="metric-label truncate">{c.label}</div>
                <div className={cn("mono mt-1 text-sm", c.score < 50 ? "text-danger" : c.score < 80 ? "text-warning" : "text-text")}>{Math.round(c.score)}</div>
                <div className="mt-1 h-0.5 rounded-full bg-bg-elevated"><div className={cn("h-0.5 rounded-full", c.score < 50 ? "bg-danger" : c.score < 80 ? "bg-warning" : "bg-success")} style={{ width: `${c.score}%` }} /></div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="tabs mb-3" role="tablist">
        <button role="tab" aria-selected={tab === "incidents"} data-active={tab === "incidents"} onClick={() => setTab("incidents")} className="tab">
          Incidents <span className="mono text-2xs text-text-faint">{incidents?.length ?? 0}</span>
        </button>
        <button role="tab" aria-selected={tab === "findings"} data-active={tab === "findings"} onClick={() => setTab("findings")} className="tab">
          Findings <span className={cn("mono text-2xs", open.length ? "text-danger" : "text-text-faint")}>{open.length} open</span>
        </button>
      </div>

      {tab === "incidents" ? (
        error && !incidents ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : loading && !incidents ? (
          <div className="space-y-1">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-11" />)}</div>
        ) : !incidents || incidents.length === 0 ? (
          <EmptyState icon={ShieldAlert} title="No incidents recorded" description="Run a cyber-range exercise to generate a simulated incident with a detection and response timeline." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="table min-w-[860px]">
              <thead className="bg-bg-raised">
                <tr><th>ID</th><th>Incident</th><th>Severity</th><th>Status</th><th>Vector → target</th><th>Response</th><th>Detected</th><th></th></tr>
              </thead>
              <tbody>
                {incidents.map((inc) => {
                  const tl = parseJSON<{ ts: string; actor: string; message: string }[]>(inc.timeline, []);
                  return (
                    <tr key={inc.id}>
                      <td className="mono text-xs text-text-faint">INC-{inc.number}</td>
                      <td className="max-w-[300px]"><div className="truncate">{inc.title}</div><div className="truncate text-xs text-text-faint">{inc.summary}</div></td>
                      <td><StatusBadge status={inc.severity} /></td>
                      <td><StatusBadge status={inc.status} /></td>
                      <td className="mono text-xs text-text-muted">{inc.attackType ?? "—"} → {inc.target ?? "—"}</td>
                      <td className="mono text-xs text-text-muted">{tl.length} steps · {duration(inc.detectedAt, inc.resolvedAt)}</td>
                      <td className="mono text-xs text-text-faint">{timeAgo(inc.detectedAt)}</td>
                      <td className="text-right"><button onClick={() => setReplay(inc)} className="btn-ghost btn-sm"><Play className="h-3 w-3" /> Replay</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : !fx ? (
        <Skeleton className="h-40" />
      ) : fx.findings.length === 0 ? (
        <EmptyState icon={ShieldAlert} title="No findings" description="Security audits and range exercises record findings here with CVSS score and remediation status." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="table min-w-[860px]">
            <thead className="bg-bg-raised">
              <tr><th>Code</th><th>Finding</th><th>Severity</th><th className="text-right">CVSS</th><th>Category</th><th>Affected</th><th>Status</th><th>Found by</th></tr>
            </thead>
            <tbody>
              {[...fx.findings].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9)).map((f) => (
                <tr key={f.id}>
                  <td className="mono text-xs text-text-faint">{f.code}</td>
                  <td className="max-w-[280px] truncate">{f.title}</td>
                  <td><StatusBadge status={f.severity} /></td>
                  <td className="mono text-right">{f.cvss.toFixed(1)}</td>
                  <td className="text-xs text-text-muted">{f.category}</td>
                  <td className="mono text-xs text-text-muted">{f.affected}</td>
                  <td><StatusBadge status={f.status} /></td>
                  <td className="text-xs text-text-muted">{f.discoveredBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {replay && <IncidentReplay incident={replay} timeline={parseJSON(replay.timeline, [])} onClose={() => setReplay(null)} />}
    </div>
  );
}
