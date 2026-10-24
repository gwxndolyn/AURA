"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useQuery } from "@/hooks/useApi";
import { useLiveEvents } from "@/hooks/useLiveEvents";
import { ActivityFeed } from "@/components/dashboard/activity-feed";
import { QuickActions } from "@/components/dashboard/quick-actions";
import { CeoDialog } from "@/components/dashboard/ceo-dialog";
import { AttentionPanel, type AttentionItem } from "@/components/dashboard/attention-panel";
import { AgentAvatar, StatusBadge, StatusDot, Skeleton, ErrorState, Badge } from "@/components/ui/primitives";
import { cn, formatCurrency, formatNumber, parseJSON, timeAgo } from "@/lib/utils";

interface Overview {
  company: {
    id: string; name: string; mission: string; status: string; revenue: number; customers: number; cash: number;
    uptime: number; securityScore: number; technicalDebt: number; simDay: number; isDemo: boolean;
  };
  agents: { id: string; key: string; name: string; role: string; avatar: string; color: string; status: string; currentTask: string | null }[];
  taskCounts: Record<string, number>;
  openFindings: number;
  activeIncidents: number;
  deployments: { id: string; env: string; version: string; status: string; stages: string; createdAt: string }[];
  usage: { todayCost: number; dailyBudget: number; cost: number; runs: number };
}

interface Task {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee: { name: string; key: string; color: string; avatar: string } | null;
  createdAt: string;
}

const PIPELINE = ["BACKLOG", "PLANNED", "IN_PROGRESS", "TESTING", "REVIEW", "BLOCKED", "DONE"] as const;
const PIPE_COLOR: Record<string, string> = {
  BACKLOG: "bg-border-strong",
  PLANNED: "bg-text-faint",
  IN_PROGRESS: "bg-brand",
  TESTING: "bg-info",
  REVIEW: "bg-warning",
  BLOCKED: "bg-danger",
  DONE: "bg-success",
};

/**
 * Operations console. Answers, from persisted state:
 *   what's running · what's blocked · what needs me · what failed · what next.
 */
export default function OverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, loading, error, refetch } = useQuery<Overview>(`/api/companies/${id}/overview`, 6000);
  const { data: attention, refetch: refetchAttention } = useQuery<AttentionItem[]>(`/api/companies/${id}/attention`, 7000);
  const { data: tasks, refetch: refetchTasks } = useQuery<Task[]>(`/api/companies/${id}/tasks`, 8000);
  const { events, connected, version } = useLiveEvents(id);
  const [ceoOpen, setCeoOpen] = useState(false);

  useEffect(() => {
    if (version > 0) {
      refetch();
      refetchAttention();
      refetchTasks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const c = data?.company;
  const working = data?.agents.filter((a) => !["IDLE", "COMPLETED"].includes(a.status)) ?? [];
  const running = tasks?.filter((t) => ["IN_PROGRESS", "TESTING", "REVIEW"].includes(t.status)) ?? [];
  const blocked = tasks?.filter((t) => t.status === "BLOCKED") ?? [];
  const failures = events.filter((e) => e.level === "danger").slice(0, 6);
  const totalTasks = PIPELINE.reduce((s, k) => s + (data?.taskCounts[k] ?? 0), 0);
  const lastDeploy = data?.deployments[0];

  return (
    <div className="page">
      <header className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="page-title">{c?.name ?? "Overview"}</h1>
            {c && <StatusBadge status={c.status} />}
            {c?.isDemo && <Badge>demo · simulated data</Badge>}
          </div>
          <p className="page-desc">{c?.mission ?? " "}</p>
        </div>
        <QuickActions companyId={id} onCeo={() => setCeoOpen(true)} />
      </header>

      {error && !data && <ErrorState message={error} onRetry={refetch} />}

      {c?.isDemo && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-bg-raised px-4 py-3" data-testid="demo-banner">
          <div className="min-w-0 flex-1 text-sm">
            <span className="font-medium text-text">This is your private demo workspace.</span>{" "}
            <span className="text-text-muted">Sample missions were produced by running the engine and are read-only. Run the example mission to drive one yourself — you approve the plan and the final change.</span>
          </div>
          <Link href={`/app/${id}/missions`} className="btn-secondary btn-sm">View missions</Link>
          <Link href={`/app/${id}/missions?example=1`} className="btn-primary btn-sm">Run example mission</Link>
        </div>
      )}

      {/* Company vitals — one compact strip, each with context. */}
      <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 xl:grid-cols-6 [&>*]:bg-bg">
        {loading && !c
          ? [...Array(6)].map((_, i) => <Skeleton key={i} className="m-3 h-10 rounded" />)
          : c && (
              <>
                <Vital label="Revenue / day" value={formatCurrency(c.revenue)} hint={`sim day ${c.simDay}`} />
                <Vital label="Customers" value={formatNumber(c.customers)} hint="active accounts" />
                <Vital label="Cash" value={formatCurrency(c.cash)} hint="runway reserve" />
                <Vital label="Uptime" value={`${c.uptime.toFixed(2)}%`} hint="weighted, all services" tone={c.uptime < 99 ? "warning" : undefined} />
                <Vital label="Security score" value={`${c.securityScore}`} suffix="/100" hint={`${data?.openFindings ?? 0} open findings`} tone={c.securityScore < 50 ? "danger" : c.securityScore < 70 ? "warning" : undefined} />
                <Vital
                  label="AI spend today"
                  value={`$${(data?.usage.todayCost ?? 0).toFixed(2)}`}
                  suffix={`/ $${data?.usage.dailyBudget ?? 0}`}
                  hint="estimated, not billed"
                  tone={(data?.usage.todayCost ?? 0) >= (data?.usage.dailyBudget ?? Infinity) * 0.8 ? "warning" : undefined}
                />
              </>
            )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5">
          {/* Needs you */}
          <Panel title="Needs you" count={attention?.length} tone={attention?.some((a) => a.level === "danger") ? "danger" : undefined}>
            <AttentionPanel companyId={id} items={attention ?? []} onChange={() => { refetch(); refetchAttention(); }} />
          </Panel>

          {/* Work pipeline */}
          <Panel
            title="Work"
            count={totalTasks || undefined}
            aside={<Link href={`/app/${id}/projects`} className="btn-ghost btn-sm">Board <ArrowUpRight className="h-3 w-3" /></Link>}
          >
            <div className="px-3 pb-1 pt-3">
              {totalTasks > 0 ? (
                <>
                  <div className="flex h-1.5 overflow-hidden rounded-full bg-bg-elevated" role="img" aria-label="Task status distribution">
                    {PIPELINE.map((k) => {
                      const n = data?.taskCounts[k] ?? 0;
                      return n ? <div key={k} className={PIPE_COLOR[k]} style={{ width: `${(n / totalTasks) * 100}%` }} /> : null;
                    })}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {PIPELINE.map((k) => (
                      <span key={k} className="inline-flex items-center gap-1.5 text-xs text-text-muted">
                        <span className={cn("dot", PIPE_COLOR[k])} />
                        {k.replace(/_/g, " ").toLowerCase()}
                        <span className="mono text-text">{data?.taskCounts[k] ?? 0}</span>
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-text-muted">No tasks yet. Use <span className="text-text">Build MVP</span> or describe a goal on the Work page.</p>
              )}
            </div>
            <TaskRows id={id} title="In flight" tasks={running} empty="Nothing in progress." />
            {blocked.length > 0 && <TaskRows id={id} title="Blocked" tasks={blocked} empty="" tone="danger" />}
          </Panel>

          {/* Failures */}
          <Panel title="Recent failures" count={failures.length || undefined} tone={failures.length ? "danger" : undefined}>
            {failures.length === 0 ? (
              <p className="px-3 py-4 text-sm text-text-muted">No failure events in the current stream.</p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {failures.map((e) => (
                  <li key={e.id} className="flex items-baseline gap-3 px-3 py-2 text-sm">
                    <span className="mono w-16 shrink-0 text-2xs text-text-faint">{new Date(e.createdAt).toLocaleTimeString("en-GB", { hour12: false })}</span>
                    <span className="w-20 shrink-0 truncate text-xs text-text-muted">{e.actorName ?? "system"}</span>
                    <span className="min-w-0 flex-1 text-danger">{e.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <aside className="min-w-0 space-y-5">
          {/* Agents */}
          <Panel title="Agents" count={data ? `${working.length}/${data.agents.length} active` : undefined} aside={<Link href={`/app/${id}/agents`} className="btn-ghost btn-sm">All <ArrowUpRight className="h-3 w-3" /></Link>}>
            {working.length === 0 ? (
              <div className="px-3 py-3">
                <p className="text-sm text-text-muted">All {data?.agents.length ?? 12} agents are idle.</p>
                {data && (
                  <div className="mt-2.5 flex flex-wrap gap-1" aria-label="Agent roster">
                    {data.agents.map((a) => (
                      <span key={a.id} title={`${a.name} · ${a.role}`}>
                        <AgentAvatar avatar={a.avatar} color={a.color} size={22} />
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {working.map((a) => (
                  <li key={a.id} className="flex items-center gap-2.5 px-3 py-2">
                    <AgentAvatar avatar={a.avatar} color={a.color} size={22} active />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">{a.name} <span className="text-xs text-text-faint">{a.role}</span></div>
                      <div className="truncate text-xs text-text-muted">{a.currentTask ?? "—"}</div>
                    </div>
                    <StatusDot status={a.status} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {/* Last deployment */}
          <Panel title="Last deployment" aside={<Link href={`/app/${id}/deployments`} className="btn-ghost btn-sm">History <ArrowUpRight className="h-3 w-3" /></Link>}>
            {lastDeploy ? (
              <div className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="mono text-sm">{lastDeploy.version}</span>
                  <span className="text-xs text-text-faint">{lastDeploy.env}</span>
                  <StatusBadge status={lastDeploy.status} />
                  <span className="ml-auto text-2xs text-text-faint">{timeAgo(lastDeploy.createdAt)}</span>
                </div>
                <StageStrip stages={lastDeploy.stages} />
              </div>
            ) : (
              <p className="px-3 py-4 text-sm text-text-muted">No deployments yet.</p>
            )}
          </Panel>

          {/* Event log */}
          <div className="h-[420px] overflow-hidden rounded-lg border border-border">
            <ActivityFeed events={events} connected={connected} filterable className="h-full" />
          </div>
        </aside>
      </div>

      <CeoDialog companyId={id} open={ceoOpen} onClose={() => setCeoOpen(false)} />
    </div>
  );
}

function Vital({ label, value, suffix, hint, tone }: { label: string; value: string; suffix?: string; hint: string; tone?: "warning" | "danger" }) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className="metric-label">{label}</div>
      <div className={cn("mono mt-1 flex items-baseline gap-1 text-lg leading-6", tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-text")}>
        {value}
        {suffix && <span className="text-xs text-text-faint">{suffix}</span>}
      </div>
      <div className="mt-0.5 truncate text-2xs text-text-faint">{hint}</div>
    </div>
  );
}

function Panel({ title, count, tone, aside, children }: { title: string; count?: number | string; tone?: "danger"; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border">
      <div className="flex h-9 items-center justify-between gap-2 border-b border-border bg-bg-raised px-3">
        <h2 className="section-title">
          {title}
          {count !== undefined && <span className={cn("mono normal-case tracking-normal", tone === "danger" ? "text-danger" : "text-text-faint")}>{count}</span>}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function TaskRows({ id, title, tasks, empty, tone }: { id: string; title: string; tasks: Task[]; empty: string; tone?: "danger" }) {
  return (
    <div className="mt-2 border-t border-border-subtle">
      <div className={cn("metric-label px-3 pb-1 pt-2", tone === "danger" && "text-danger")}>{title}</div>
      {tasks.length === 0 ? (
        <p className="px-3 pb-3 text-sm text-text-muted">{empty}</p>
      ) : (
        <table className="table">
          <tbody>
            {tasks.slice(0, 8).map((t) => (
              <tr key={t.id}>
                <td className="w-full max-w-0">
                  <Link href={`/app/${id}/projects`} className="block truncate hover:underline">{t.title}</Link>
                </td>
                <td className="whitespace-nowrap">
                  <StatusBadge status={t.priority} />
                </td>
                <td className="whitespace-nowrap text-xs text-text-muted">{t.assignee?.name ?? "unassigned"}</td>
                <td className="whitespace-nowrap"><StatusDot status={t.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const STAGES = ["BUILD", "TEST", "SECURITY_SCAN", "DEPLOY", "HEALTH_CHECK"];
function StageStrip({ stages }: { stages: string }) {
  const parsed = parseJSON<{ name: string; status: string }[] | { summary: unknown }>(stages, []);
  const list = Array.isArray(parsed) ? parsed : [];
  return (
    <ol className="mt-2 flex gap-1" aria-label="Pipeline stages">
      {STAGES.map((n) => {
        const s = list.find((x) => x.name === n);
        const cls = s?.status === "SUCCESS" ? "bg-success" : s?.status === "FAILED" ? "bg-danger" : "bg-border-strong";
        return (
          <li key={n} className="min-w-0 flex-1" title={`${n.replace(/_/g, " ").toLowerCase()}: ${s?.status?.toLowerCase() ?? "not run"}`}>
            <div className={cn("h-1 rounded-full", cls)} />
            <div className="mono mt-1 truncate text-2xs text-text-faint">{n.replace(/_/g, " ").toLowerCase()}</div>
          </li>
        );
      })}
    </ol>
  );
}
