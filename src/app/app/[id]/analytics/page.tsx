"use client";

import { use, useState } from "react";
import { BarChart3, Table2, LineChart as LineIcon } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useQuery } from "@/hooks/useApi";
import { Skeleton, PageHeader, SimulatedNotice, EmptyState, ErrorState } from "@/components/ui/primitives";
import { chart, palette } from "@/lib/theme";
import { cn, formatCurrency, formatNumber } from "@/lib/utils";

interface Metric { simDay: number; revenue: number; customers: number; cash: number; uptime: number; securityScore: number; incidents: number; technicalDebt: number }
interface Analytics {
  metrics: Metric[];
  dora: { deploymentFrequency: number; changeFailureRate: number; mttrMinutes: number | null; mttrSample: number; deploySuccess: number; deployFail: number };
  incidents: number;
  findings: number;
}

const RANGES = ["7D", "30D", "90D"] as const;

interface ChartDef {
  key: keyof Metric;
  title: string;
  question: string;
  format: (n: number) => string;
  domain?: [number, number];
}

/** One measure per chart (no dual axes). Each title states the question it answers. */
const CHARTS: ChartDef[] = [
  { key: "revenue", title: "Revenue per day", question: "Is revenue growing?", format: (n) => formatCurrency(n) },
  { key: "customers", title: "Customers", question: "Are we gaining or losing accounts?", format: (n) => formatNumber(n) },
  { key: "securityScore", title: "Security score", question: "Is posture improving?", format: (n) => `${Math.round(n)}`, domain: [0, 100] },
  { key: "uptime", title: "Uptime", question: "Are services reliable?", format: (n) => `${n.toFixed(2)}%` },
  { key: "technicalDebt", title: "Technical debt", question: "Is debt accumulating faster than it is paid down?", format: (n) => `${Math.round(n)}`, domain: [0, 100] },
  { key: "incidents", title: "Active incidents", question: "How many incidents were open each day?", format: (n) => `${Math.round(n)}` },
];

function trend(values: number[]): { delta: number; pct: number | null } {
  if (values.length < 2) return { delta: 0, pct: null };
  const a = values[0];
  const b = values[values.length - 1];
  return { delta: b - a, pct: a !== 0 ? (b - a) / Math.abs(a) : null };
}

export default function AnalyticsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [range, setRange] = useState<(typeof RANGES)[number]>("30D");
  const [table, setTable] = useState(false);
  const { data, loading, error, refetch } = useQuery<Analytics>(`/api/companies/${id}/analytics?range=${range}`, 8000);
  const metrics = data?.metrics ?? [];
  const deploys = data?.dora.deploymentFrequency ?? 0;

  return (
    <div className="page">
      <PageHeader
        title="Analytics"
        description="Daily snapshots written by the simulation engine, plus delivery metrics computed from recorded deployments and incidents."
        actions={
          <>
            <div className="segmented" role="group" aria-label="Time range">
              {RANGES.map((r) => <button key={r} data-active={range === r} onClick={() => setRange(r)}>{r.toLowerCase()}</button>)}
            </div>
            <div className="segmented" role="group" aria-label="View">
              <button data-active={!table} onClick={() => setTable(false)} aria-label="Chart view"><LineIcon className="h-3 w-3" /></button>
              <button data-active={table} onClick={() => setTable(true)} aria-label="Table view"><Table2 className="h-3 w-3" /></button>
            </div>
          </>
        }
      />
      <div className="mb-4"><SimulatedNotice>Business metrics are simulated. Delivery metrics are computed from this workspace&apos;s recorded deployments and incidents.</SimulatedNotice></div>

      {error && !data && <ErrorState message={error} onRetry={refetch} />}

      {/* Delivery (DORA-style) — computed, with denominators shown. */}
      <dl className="mb-6 grid grid-cols-2 divide-x divide-border overflow-hidden rounded-lg border border-border md:grid-cols-4">
        <Kpi label="Deployments" value={`${deploys}`} hint={`${data?.dora.deploySuccess ?? 0} succeeded · ${data?.dora.deployFail ?? 0} failed`} />
        <Kpi label="Change failure rate" value={deploys ? `${Math.round((data?.dora.changeFailureRate ?? 0) * 100)}%` : "—"} hint={deploys ? `${data?.dora.deployFail} of ${deploys} deployments` : "no deployments yet"} />
        <Kpi label="Mean time to recover" value={data?.dora.mttrMinutes != null ? `${data.dora.mttrMinutes}m` : "—"} hint={data?.dora.mttrSample ? `over ${data.dora.mttrSample} resolved incident${data.dora.mttrSample === 1 ? "" : "s"}` : "no resolved incidents with valid timestamps"} />
        <Kpi label="Security findings" value={`${data?.findings ?? 0}`} hint="all-time, any status" />
      </dl>

      {loading && !data ? (
        <div className="grid gap-4 lg:grid-cols-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-64" />)}</div>
      ) : metrics.length < 2 ? (
        <EmptyState icon={BarChart3} title="Not enough history to chart" description={`Trends need at least two simulated days (have ${metrics.length}). Advance the simulation clock in the top bar.`} />
      ) : table ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="table min-w-[720px]">
            <thead className="bg-bg-raised"><tr><th>Day</th><th className="text-right">Revenue</th><th className="text-right">Customers</th><th className="text-right">Cash</th><th className="text-right">Uptime</th><th className="text-right">Security</th><th className="text-right">Tech debt</th><th className="text-right">Incidents</th></tr></thead>
            <tbody>
              {[...metrics].reverse().map((m) => (
                <tr key={m.simDay} className="mono text-xs">
                  <td>{m.simDay}</td><td className="text-right">{formatCurrency(m.revenue, false)}</td><td className="text-right">{m.customers}</td><td className="text-right">{formatCurrency(m.cash)}</td>
                  <td className="text-right">{m.uptime.toFixed(2)}%</td><td className="text-right">{m.securityScore}</td><td className="text-right">{m.technicalDebt}</td><td className="text-right">{m.incidents}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {CHARTS.map((c) => {
            const values = metrics.map((m) => m[c.key] as number);
            const t = trend(values);
            const last = values[values.length - 1];
            return (
              <section key={c.key} className="rounded-lg border border-border">
                <header className="flex items-start justify-between gap-3 px-4 pt-3">
                  <div>
                    <h2 className="text-sm font-medium">{c.title}</h2>
                    <p className="text-xs text-text-faint">{c.question}</p>
                  </div>
                  <div className="text-right">
                    <div className="mono text-lg leading-6">{c.format(last)}</div>
                    <div className={cn("mono text-2xs", t.delta > 0 ? "text-success" : t.delta < 0 ? "text-danger" : "text-text-faint")}>
                      {t.delta === 0 ? "flat" : `${t.delta > 0 ? "▲" : "▼"} ${t.pct !== null ? `${Math.abs(t.pct * 100).toFixed(1)}%` : c.format(Math.abs(t.delta))}`} <span className="text-text-faint">day {metrics[0].simDay} → {metrics[metrics.length - 1].simDay}</span>
                    </div>
                  </div>
                </header>
                <div className="h-[200px] px-2 pb-2 pt-3">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={metrics} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id={`fill-${c.key}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={chart.series[0]} stopOpacity={0.18} />
                          <stop offset="100%" stopColor={chart.series[0]} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} stroke={chart.grid} />
                      <XAxis dataKey="simDay" stroke={chart.axis} fontSize={11} tickLine={false} axisLine={false} tickFormatter={(d) => `d${d}`} minTickGap={24} />
                      <YAxis stroke={chart.axis} fontSize={11} tickLine={false} axisLine={false} width={58} tickFormatter={(v) => c.format(v)} domain={c.domain ?? ["auto", "auto"]} />
                      <Tooltip cursor={{ stroke: palette.border.strong }} content={<ChartTip format={c.format} names={{ [c.key]: c.title }} />} />
                      <Area type={c.key === "incidents" ? "stepAfter" : "monotone"} dataKey={c.key} stroke={chart.series[0]} strokeWidth={2} fill={`url(#fill-${c.key})`} activeDot={{ r: 4, stroke: palette.bg.raised, strokeWidth: 2 }} isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="px-3 py-2.5">
      <dt className="metric-label">{label}</dt>
      <dd className="mono mt-1 text-lg">{value}</dd>
      <div className="text-2xs text-text-faint">{hint}</div>
    </div>
  );
}

interface TipPayload { dataKey: string; value: number; color: string }
function ChartTip({ active, payload, label: dayLabel, format, names }: { active?: boolean; payload?: TipPayload[]; label?: string | number; format: (v: number) => string; names?: Record<string, string> }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border-strong bg-bg-elevated px-2.5 py-1.5 text-xs shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
      <div className="mono mb-1 text-2xs text-text-faint">day {dayLabel}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="h-0.5 w-2.5 rounded" style={{ background: p.color }} />
          <span className="text-text-muted">{names?.[p.dataKey] ?? p.dataKey}</span>
          <span className="mono ml-auto pl-3 text-text">{format(p.value)}</span>
        </div>
      ))}
    </div>
  );
}
