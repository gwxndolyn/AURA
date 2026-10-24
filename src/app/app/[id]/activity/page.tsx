"use client";

import { use, useMemo, useState } from "react";
import { useQuery } from "@/hooks/useApi";
import { Skeleton, PageHeader, ErrorState } from "@/components/ui/primitives";
import { cn, timeAgo } from "@/lib/utils";

interface AgentMsg {
  id: string;
  type: string;
  severity: string;
  message: string;
  createdAt: string;
  from: { name: string; key: string; color: string };
  to: { name: string; key: string; color: string };
}
interface Data {
  audit: { id: string; actor: string; action: string; target: string; result: string; createdAt: string }[];
  timeline: { id: string; title: string; kind: string; simDay: number }[];
  messages: AgentMsg[];
}

const SEV_TONE: Record<string, string> = { CRITICAL: "text-danger", HIGH: "text-danger", MEDIUM: "text-warning", LOW: "text-text-muted", INFO: "text-text-faint" };
type Tab = "audit" | "messages" | "timeline";

export default function ActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, loading, error, refetch } = useQuery<Data>(`/api/companies/${id}/activity`, 6000);
  const [tab, setTab] = useState<Tab>("audit");
  const [q, setQ] = useState("");

  const audit = useMemo(
    () => (data?.audit ?? []).filter((a) => !q || `${a.actor} ${a.action} ${a.target} ${a.result}`.toLowerCase().includes(q.toLowerCase())),
    [data, q],
  );
  const msgs = useMemo(
    () => (data?.messages ?? []).filter((m) => !q || `${m.from.name} ${m.to.name} ${m.type} ${m.message}`.toLowerCase().includes(q.toLowerCase())),
    [data, q],
  );

  const tabs: { k: Tab; label: string; n?: number }[] = [
    { k: "audit", label: "Audit log", n: data?.audit.length },
    { k: "messages", label: "Agent messages", n: data?.messages.length },
    { k: "timeline", label: "Company timeline", n: data?.timeline.length },
  ];

  return (
    <div className="page">
      <PageHeader title="Activity & Audit" description="Append-only audit records of agent and operator actions, structured agent-to-agent messages, and company milestones." />

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="tabs flex-1" role="tablist">
          {tabs.map((t) => (
            <button key={t.k} role="tab" aria-selected={tab === t.k} data-active={tab === t.k} onClick={() => setTab(t.k)} className="tab">
              {t.label} {t.n !== undefined && <span className="mono text-2xs text-text-faint">{t.n}</span>}
            </button>
          ))}
        </div>
        {tab !== "timeline" && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter entries" className="input w-56" />}
      </div>

      {error && !data ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : loading && !data ? (
        <div className="space-y-1">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-9" />)}</div>
      ) : tab === "audit" ? (
        audit.length === 0 ? (
          <p className="py-6 text-sm text-text-muted">{data?.audit.length ? "No entries match the filter." : "No audit entries yet. Tool calls, approvals, deployments and evaluations are recorded here as they happen."}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="table min-w-[760px]">
              <thead className="bg-bg-raised"><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Result</th></tr></thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="mono whitespace-nowrap text-xs text-text-faint" title={new Date(a.createdAt).toISOString()}>{timeAgo(a.createdAt)}</td>
                    <td className="mono text-xs">{a.actor}</td>
                    <td className={cn("mono text-xs", /DENIED|BLOCKED|REJECT/.test(a.action) ? "text-danger" : "text-text")}>{a.action}</td>
                    <td className="mono max-w-[200px] truncate text-xs text-text-muted" title={a.target}>{a.target}</td>
                    <td className="max-w-[360px] truncate text-xs text-text-muted" title={a.result}>{a.result}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : tab === "messages" ? (
        msgs.length === 0 ? (
          <p className="py-6 text-sm text-text-muted">{data?.messages.length ? "No messages match the filter." : "No agent messages yet. Bug reports, handoffs and conflict notices between agents appear here during workflows."}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="table min-w-[760px]">
              <thead className="bg-bg-raised"><tr><th>When</th><th>From → to</th><th>Type</th><th>Severity</th><th>Message</th></tr></thead>
              <tbody>
                {msgs.map((m) => (
                  <tr key={m.id}>
                    <td className="mono whitespace-nowrap text-xs text-text-faint">{timeAgo(m.createdAt)}</td>
                    <td className="whitespace-nowrap text-xs">{m.from.name} <span className="text-text-faint">→</span> {m.to.name}</td>
                    <td className="mono text-xs text-text-muted">{m.type.toLowerCase()}</td>
                    <td className={cn("mono text-xs", SEV_TONE[m.severity])}>{m.severity.toLowerCase()}</td>
                    <td className="text-xs text-text-muted">{m.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (data?.timeline.length ?? 0) === 0 ? (
        <p className="py-6 text-sm text-text-muted">No milestones recorded.</p>
      ) : (
        <ol className="max-w-2xl">
          {data?.timeline.map((t, i) => (
            <li key={t.id} className="grid grid-cols-[64px_16px_1fr] gap-x-2">
              <span className="mono pt-0.5 text-2xs text-text-faint">day {t.simDay}</span>
              <span className="relative flex justify-center">
                <span className="dot mt-1.5 bg-text-muted" />
                {i < (data?.timeline.length ?? 0) - 1 && <span className="absolute top-4 h-full w-px bg-border" />}
              </span>
              <div className="pb-4">
                <div className="text-sm">{t.title}</div>
                <div className="mono text-2xs text-text-faint">{t.kind}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
