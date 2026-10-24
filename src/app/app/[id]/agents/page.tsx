"use client";

import { use, useMemo, useState } from "react";
import { Users } from "lucide-react";
import { useQuery } from "@/hooks/useApi";
import { AgentAvatar, StatusDot, Skeleton, PageHeader, EmptyState, ErrorState, SimulatedNotice } from "@/components/ui/primitives";
import { AgentPanel } from "@/components/agents/agent-panel";
import { getAgentDef } from "@/lib/agents/definitions";
import { cn, parseJSON } from "@/lib/utils";

interface Agent {
  id: string;
  key: string;
  name: string;
  role: string;
  avatar: string;
  color: string;
  status: string;
  currentTask: string | null;
  available: boolean;
  permissions: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  tasksDone: number;
  tasksFailed: number;
}

const FILTERS = ["all", "active", "idle", "unavailable"] as const;

/** Agent directory: one row per AI employee, with real capability + usage data. */
export default function AgentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: agents, loading, error, refetch } = useQuery<Agent[]>(`/api/companies/${id}/agents`, 5000);
  const { data: company } = useQuery<{ isDemo: boolean }>(`/api/companies/${id}`);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [q, setQ] = useState("");

  const rows = useMemo(
    () =>
      (agents ?? [])
        .filter((a) => {
          if (filter === "active") return !["IDLE", "COMPLETED"].includes(a.status);
          if (filter === "idle") return ["IDLE", "COMPLETED"].includes(a.status);
          if (filter === "unavailable") return !a.available;
          return true;
        })
        .filter((a) => !q || `${a.name} ${a.role} ${a.key}`.toLowerCase().includes(q.toLowerCase())),
    [agents, filter, q],
  );
  const active = agents?.filter((a) => !["IDLE", "COMPLETED"].includes(a.status)).length ?? 0;

  return (
    <div className="page">
      <PageHeader
        title="Agents"
        description="AI employees, their tool permissions and recorded usage. Select a row for run history and memory."
        meta={agents && <span className="mono text-xs text-text-faint">{active} active · {agents.length} total</span>}
      />

      {company?.isDemo && (
        <div className="mb-3">
          <SimulatedNotice>Done / tokens / cost counters on this demo workspace start from seeded values; run history in each agent&apos;s panel shows only runs actually recorded here.</SimulatedNotice>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or role" aria-label="Filter agents" className="input w-60" />
        <div className="segmented" role="group" aria-label="Status filter">
          {FILTERS.map((f) => (
            <button key={f} data-active={filter === f} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>

      {error && !agents ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : loading && !agents ? (
        <div className="space-y-1">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Users} title="No agents match" description="Clear the filter to see all agents in this workspace." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="table min-w-[920px]">
            <thead className="bg-bg-raised">
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Current work</th>
                <th>Model tier</th>
                <th>Tools</th>
                <th className="text-right">Done</th>
                <th className="text-right">Failed</th>
                <th className="text-right">Tokens</th>
                <th className="text-right">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const def = getAgentDef(a.key);
                const tools = parseJSON<string[]>(a.permissions, []);
                return (
                  <tr
                    key={a.id}
                    data-interactive="true"
                    tabIndex={0}
                    onClick={() => setSelected(a.id)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSelected(a.id))}
                    aria-label={`${a.name}, ${a.role}`}
                    className={cn(selected === a.id && "bg-bg-hover")}
                  >
                    <td>
                      <div className="flex items-center gap-2.5">
                        <AgentAvatar avatar={a.avatar} color={a.color} size={24} active={!["IDLE", "COMPLETED"].includes(a.status)} />
                        <div className="min-w-0">
                          <div className="text-sm">{a.name}</div>
                          <div className="text-xs text-text-faint">{a.role}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="flex flex-col gap-0.5">
                        <StatusDot status={a.status} />
                        {!a.available && <span className="text-2xs text-warning">unavailable</span>}
                      </div>
                    </td>
                    <td className="max-w-[260px] truncate text-xs text-text-muted" title={a.currentTask ?? undefined}>{a.currentTask ?? "—"}</td>
                    <td className="mono text-xs text-text-muted">{def?.tier.toLowerCase() ?? "—"}</td>
                    <td>
                      <div className="flex items-center gap-1" title={tools.join(", ")}>
                        {tools.filter((t) => t !== "message.send").slice(0, 2).map((t) => (
                          <span key={t} className="chip border border-border text-text-muted">{t}</span>
                        ))}
                        {tools.filter((t) => t !== "message.send").length > 2 && <span className="mono text-2xs text-text-faint">+{tools.filter((t) => t !== "message.send").length - 2}</span>}
                        {tools.length === 1 && tools[0] === "message.send" && <span className="mono text-2xs text-text-faint">message only</span>}
                      </div>
                    </td>
                    <td className="mono text-right">{a.tasksDone}</td>
                    <td className={cn("mono text-right", a.tasksFailed > 0 ? "text-danger" : "text-text-faint")}>{a.tasksFailed}</td>
                    <td className="mono text-right text-text-muted">{((a.tokensIn + a.tokensOut) / 1000).toFixed(1)}k</td>
                    <td className="mono text-right text-text-muted">${a.cost.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && <AgentPanel companyId={id} agentId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
