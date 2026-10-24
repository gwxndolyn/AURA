"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { useQuery } from "@/hooks/useApi";
import { AgentAvatar, StatusDot, StatusBadge, Skeleton, ErrorState } from "@/components/ui/primitives";
import { getAgentDef } from "@/lib/agents/definitions";
import { timeAgo, parseJSON } from "@/lib/utils";

interface Detail {
  agent: {
    id: string; key: string; name: string; role: string; avatar: string; color: string; personality: string;
    status: string; currentTask: string | null; permissions: string; available: boolean;
    tokensIn: number; tokensOut: number; cost: number; tasksDone: number; tasksFailed: number;
  };
  runs: { id: string; objective: string; model: string; tier: string; summary: string; status: string; cost: number; latencyMs: number; tokensIn: number; tokensOut: number; createdAt: string; promptRef?: string; toolCalls: { id: string; tool: string; input: string; ok: boolean }[] }[];
  memories: { id: string; content: string; kind: string; createdAt: string }[];
  tasks: { id: string; title: string; status: string }[];
}

/** Agent detail drawer. All data from /api/companies/[id]/agents/[agentId]. */
export function AgentPanel({ companyId, agentId, onClose }: { companyId: string; agentId: string; onClose: () => void }) {
  const { data, loading, error, refetch } = useQuery<Detail>(`/api/companies/${companyId}/agents/${agentId}`, 4000);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const def = data ? getAgentDef(data.agent.key) : undefined;
  const tools = data ? parseJSON<string[]>(data.agent.permissions, []) : [];
  const touched = Array.from(
    new Set(
      (data?.runs ?? []).flatMap((r) =>
        r.toolCalls
          .filter((t) => t.tool.startsWith("filesystem"))
          .flatMap((t) => {
            const i = parseJSON<{ path?: string; paths?: string[] }>(t.input, {});
            return i.paths ?? (i.path ? [i.path] : []);
          }),
      ),
    ),
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Agent details">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-[520px] animate-fade-in flex-col border-l border-border-strong bg-bg-raised">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <span className="metric-label">Agent</span>
          <button onClick={onClose} className="icon-btn" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {error && !data ? (
            <div className="p-4"><ErrorState message={error} onRetry={refetch} /></div>
          ) : loading && !data ? (
            <div className="space-y-2 p-4">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : data ? (
            <>
              <div className="border-b border-border p-4">
                <div className="flex items-start gap-3">
                  <AgentAvatar avatar={data.agent.avatar} color={data.agent.color} size={36} active={!["IDLE", "COMPLETED"].includes(data.agent.status)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-medium">{data.agent.name}</span>
                      <StatusDot status={data.agent.status} />
                    </div>
                    <div className="text-xs text-text-muted">{data.agent.role} · <span className="mono">{data.agent.key}</span></div>
                  </div>
                </div>
                <p className="mt-3 text-sm text-text-muted">{data.agent.currentTask ? <>Working on <span className="text-text">{data.agent.currentTask}</span></> : "Not currently assigned."}</p>
                <dl className="mono mt-4 grid grid-cols-4 gap-3 text-xs">
                  <Fact k="done" v={data.agent.tasksDone} />
                  <Fact k="failed" v={data.agent.tasksFailed} />
                  <Fact k="tokens" v={`${((data.agent.tokensIn + data.agent.tokensOut) / 1000).toFixed(1)}k`} />
                  <Fact k="est. cost" v={`$${data.agent.cost.toFixed(2)}`} />
                </dl>
              </div>

              <Block title="Capabilities">
                <div className="flex flex-wrap gap-1">
                  {def?.capabilities.map((c) => <span key={c} className="chip border border-border text-text-muted">{c}</span>)}
                </div>
                <div className="mt-2 text-xs text-text-faint">Default model tier: <span className="mono text-text-muted">{def?.tier.toLowerCase()}</span></div>
              </Block>

              <Block title={`Permitted tools · ${tools.length}`}>
                <div className="flex flex-wrap gap-1">
                  {tools.map((t) => <span key={t} className="chip border border-border text-text">{t}</span>)}
                </div>
                <p className="mt-2 text-xs text-text-faint">Enforced server-side by the tool runner; calls outside this list are denied and audited.</p>
              </Block>

              <Block title={`Recent runs · ${data.runs.length}`}>
                {data.runs.length === 0 ? (
                  <p className="text-sm text-text-muted">No runs recorded yet.</p>
                ) : (
                  <ul className="divide-y divide-border-subtle">
                    {data.runs.map((r) => (
                      <li key={r.id} className="py-2">
                        <div className="flex items-start gap-2">
                          <span className="min-w-0 flex-1 text-sm">{r.summary || r.objective}</span>
                          <StatusBadge status={r.status} />
                        </div>
                        <div className="mono mt-1 flex flex-wrap gap-x-3 text-2xs text-text-faint">
                          <span>{r.model}</span>
                          <span>{r.latencyMs}ms</span>
                          <span>{r.tokensIn + r.tokensOut} tok</span>
                          <span>${r.cost.toFixed(4)}</span>
                          {r.promptRef && <span>{r.promptRef}</span>}
                          <span>{timeAgo(r.createdAt)}</span>
                        </div>
                        {r.toolCalls.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {r.toolCalls.map((t) => (
                              <span key={t.id} className={`chip border ${t.ok ? "border-border text-text-muted" : "border-danger/30 text-danger"}`}>{t.tool}{t.ok ? "" : " ✕"}</span>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Block>

              {touched.length > 0 && (
                <Block title="Files written">
                  <ul className="mono space-y-0.5 text-xs text-text-muted">{touched.slice(0, 10).map((f) => <li key={f}>{f}</li>)}</ul>
                </Block>
              )}

              <Block title={`Assigned tasks · ${data.tasks.length}`}>
                {data.tasks.length === 0 ? <p className="text-sm text-text-muted">None.</p> : (
                  <ul className="space-y-1">{data.tasks.map((t) => <li key={t.id} className="flex items-center justify-between gap-2 text-sm"><span className="truncate">{t.title}</span><StatusDot status={t.status} /></li>)}</ul>
                )}
              </Block>

              <Block title="Memory">
                {data.memories.length === 0 ? <p className="text-sm text-text-muted">No stored memory.</p> : (
                  <ul className="space-y-1">
                    {data.memories.map((m) => (
                      <li key={m.id} className="flex gap-2 text-xs">
                        <span className="mono w-10 shrink-0 text-text-faint">{m.kind}</span>
                        <span className="text-text-muted">{m.content}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Block>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs text-text-faint">{k}</dt>
      <dd className="mt-0.5 text-sm text-text">{v}</dd>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border p-4">
      <h3 className="section-title mb-2">{title}</h3>
      {children}
    </section>
  );
}
