"use client";

import { Suspense, use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Gauge, Loader2, RefreshCw, Settings2 } from "lucide-react";
import { useQuery, useMutation } from "@/hooks/useApi";
import { useLiveEvents } from "@/hooks/useLiveEvents";
import { PageHeader, EmptyState, ErrorState, Skeleton, Badge, Section } from "@/components/ui/primitives";
import { FindingInspector } from "@/components/ops/finding-inspector";
import { CertaintyBadge, SeverityBadge } from "@/components/ops/badges";
import { MonitorSettings } from "@/components/ops/monitor-settings";
import { useApp } from "@/lib/store";
import { cn, timeAgo } from "@/lib/utils";

interface Briefing {
  generatedAt: string;
  monitor: { enabled: boolean; policyLevel: string; intervalSec: number; lastRunAt: string | null; aiSummaries: boolean } | null;
  coverage: { evaluatedAt: string; rules: number; unknownCount: number } | null;
  summary: string;
  attention: { id: string; title: string; severity: string; certainty: string; resourceLabel: string; requiresHuman: boolean; priorityReason: string }[];
  totalOpen: number;
  blockedOrFailing: { id: string; title: string; status: string; reason: string }[];
  approvals: { id: string; missionId: string; title: string; what: string; since: string }[];
  regressions: { id: string; title: string; certainty: string }[];
  unknown: { ruleId: string; resource: string; reason: string }[];
  next: { findingId: string | null; text: string; because: string } | null;
}
interface FindingRow {
  id: string;
  title: string;
  severity: string;
  certainty: string;
  status: string;
  category: string;
  resourceType: string;
  resourceLabel: string;
  ruleId: string;
  requiresHuman: boolean;
  occurrences: number;
  lastObservedAt: string;
}
interface OpsEvent {
  id: string;
  message: string;
  severity: string | null;
  source: string | null;
  resourceType: string | null;
  resolution: string | null;
  createdAt: string;
}

const STATUS_SETS: Record<string, string[]> = { active: ["OPEN", "ACKNOWLEDGED", "INVESTIGATING"], resolved: ["RESOLVED"], dismissed: ["DISMISSED"], all: [] };
const SEVERITIES = ["critical", "high", "medium", "low"];
const CATEGORIES = ["mission", "agent", "engineering", "evaluation"];
const RANGES = [{ label: "24h", hours: 24 }, { label: "7d", hours: 168 }, { label: "30d", hours: 720 }, { label: "all", hours: 0 }];
const SEV_DOT: Record<string, string> = { critical: "bg-danger", high: "bg-danger", medium: "bg-warning", low: "bg-text-faint" };

export default function OperationsPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="page"><Skeleton className="h-40" /></div>}>
      <Operations params={params} />
    </Suspense>
  );
}

function Operations({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const search = useSearchParams();
  const { toast } = useApp();
  const base = `/api/companies/${id}/ops`;
  const [statusSet, setStatusSet] = useState<keyof typeof STATUS_SETS>("active");
  const [sev, setSev] = useState<string[]>([]);
  const [cat, setCat] = useState<string>("");
  const [hours, setHours] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [tick, setTick] = useState(0);
  const selected = search.get("finding");

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (STATUS_SETS[statusSet].length) p.set("status", STATUS_SETS[statusSet].join(","));
    if (sev.length) p.set("severity", sev.join(","));
    if (cat) p.set("category", cat);
    if (hours) p.set("hours", String(hours));
    return p.toString();
  }, [statusSet, sev, cat, hours]);

  const { data: brief, error: briefErr, refetch: refetchBrief } = useQuery<Briefing>(`${base}/briefing`, 15000);
  const { data: findings, error, loading, refetch } = useQuery<FindingRow[]>(`${base}/findings?${qs}`, 15000);
  const { data: events, refetch: refetchEvents } = useQuery<OpsEvent[]>(`${base}/events?hours=${hours || 168}`, 20000);
  const evalMut = useMutation<unknown, { ran: boolean; reason?: string; opened?: number; resolved?: number; reopened?: number; unknown?: number }>();
  const { version } = useLiveEvents(id);

  useEffect(() => {
    if (version > 0) {
      setTick((t) => t + 1);
      refetch();
      refetchBrief();
      refetchEvents();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const select = (fid: string | null) => router.replace(`/app/${id}/operations${fid ? `?finding=${fid}` : ""}`, { scroll: false });
  const refreshAll = () => {
    setTick((t) => t + 1);
    refetch();
    refetchBrief();
    refetchEvents();
  };

  async function evaluateNow() {
    try {
      const r = await evalMut.mutate(`${base}/evaluate`);
      toast({ title: r.ran ? "Health evaluation complete" : "Evaluation not run", description: r.ran ? `${r.opened} opened · ${r.resolved} resolved · ${r.reopened} re-opened · ${r.unknown} unknown` : r.reason, level: r.ran ? "success" : "info" });
      refreshAll();
    } catch (e) {
      toast({ title: "Evaluation failed", description: (e as Error).message, level: "danger" });
    }
  }

  const permissionDenied = (briefErr ?? error)?.match(/Requires|not found/i);

  return (
    <div className="page">
      <PageHeader
        title="Operations"
        description="Findings derived by deterministic rules from recorded missions, runs, deployments and evaluations. Every finding links to the evidence that raised it."
        meta={brief?.monitor && <Badge>policy · {brief.monitor.policyLevel.toLowerCase()}</Badge>}
        actions={
          <>
            <button onClick={() => setShowSettings((v) => !v)} className="btn-ghost" aria-expanded={showSettings}><Settings2 className="h-3.5 w-3.5" /> Monitor &amp; policy</button>
            <button onClick={evaluateNow} disabled={evalMut.loading} className="btn-primary" data-testid="evaluate-now">
              {evalMut.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Evaluate now
            </button>
          </>
        }
      />

      {showSettings && <MonitorSettings companyId={id} onSaved={refreshAll} />}

      {permissionDenied ? (
        <EmptyState icon={Gauge} title="You don't have access to this workspace's operations" description="Ask a workspace owner to add you as a member." />
      ) : (
        <>
          {/* Briefing */}
          <section aria-label="Briefing" className="mb-5 grid gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] [&>*]:bg-bg" data-testid="briefing">
            <div className="p-4">
              <div className="metric-label">Briefing</div>
              {!brief ? <Skeleton className="mt-2 h-10" /> : (
                <>
                  <p className="mt-1 text-sm text-text" data-testid="briefing-summary">{brief.summary}</p>
                  {brief.next && (
                    <p className="mt-2 text-sm">
                      <span className="metric-label mr-1.5">Next</span>
                      {brief.next.findingId ? <button className="text-left text-brand hover:underline" onClick={() => select(brief.next!.findingId)}>{brief.next.text}</button> : <span>{brief.next.text}</span>}
                      <span className="block text-xs text-text-muted">because: {brief.next.because}</span>
                    </p>
                  )}
                  <p className="mono mt-2 text-2xs text-text-faint">
                    {brief.coverage ? `last evaluated ${timeAgo(brief.coverage.evaluatedAt)} · ${brief.coverage.rules} checks · ${brief.coverage.unknownCount} unknown (insufficient evidence)` : "never evaluated"}
                    {brief.monitor && ` · monitor ${brief.monitor.enabled ? `every ${Math.round(brief.monitor.intervalSec / 60)}m` : "disabled"}`}
                  </p>
                </>
              )}
            </div>
            <div className="p-4">
              <div className="metric-label">Waiting on a person</div>
              {!brief ? <Skeleton className="mt-2 h-10" /> : brief.approvals.length === 0 ? <p className="mt-1 text-sm text-text-muted">No pending approvals.</p> : (
                <ul className="mt-1 space-y-1 text-sm">
                  {brief.approvals.slice(0, 4).map((a) => (
                    <li key={a.id}><Link className="hover:underline" href={`/app/${id}/missions/${a.missionId}`}>{a.title}</Link><span className="block text-2xs text-text-faint">{a.what} · {timeAgo(a.since)}</span></li>
                  ))}
                </ul>
              )}
            </div>
            <div className="p-4">
              <div className="metric-label">Blocked or failing missions</div>
              {!brief ? <Skeleton className="mt-2 h-10" /> : brief.blockedOrFailing.length === 0 ? <p className="mt-1 text-sm text-text-muted">None.</p> : (
                <ul className="mt-1 space-y-1 text-sm">
                  {brief.blockedOrFailing.slice(0, 4).map((m) => (
                    <li key={m.id}><Link className="hover:underline" href={`/app/${id}/missions/${m.id}`}>{m.title}</Link><span className="block text-2xs text-text-faint">{m.status.toLowerCase()}</span></li>
                  ))}
                </ul>
              )}
              {brief && brief.regressions.length > 0 && <p className="mt-2 text-xs text-warning">{brief.regressions.length} evaluation regression(s)</p>}
            </div>
          </section>

          {/* Filters */}
          <div className="mb-2 flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
            <div className="segmented" role="group" aria-label="Status">
              {(Object.keys(STATUS_SETS) as (keyof typeof STATUS_SETS)[]).map((s) => <button key={s} data-active={statusSet === s} onClick={() => setStatusSet(s)}>{s}</button>)}
            </div>
            <div className="segmented" role="group" aria-label="Severity">
              {SEVERITIES.map((s) => <button key={s} data-active={sev.includes(s)} onClick={() => setSev((v) => (v.includes(s) ? v.filter((x) => x !== s) : [...v, s]))}>{s}</button>)}
            </div>
            <div className="segmented" role="group" aria-label="Area">
              <button data-active={cat === ""} onClick={() => setCat("")}>all areas</button>
              {CATEGORIES.map((c) => <button key={c} data-active={cat === c} onClick={() => setCat(c)}>{c}</button>)}
            </div>
            <div className="segmented" role="group" aria-label="Time range">
              {RANGES.map((r) => <button key={r.label} data-active={hours === r.hours} onClick={() => setHours(r.hours)}>{r.label}</button>)}
            </div>
          </div>

          {/* Findings list + inspector */}
          <div className={cn("grid gap-4", selected ? "xl:grid-cols-[minmax(0,1fr)_480px]" : "")}>
            <div className="min-w-0">
              {error && !findings ? (
                <ErrorState message={error} onRetry={refetch} />
              ) : loading && !findings ? (
                <div className="space-y-1">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
              ) : !findings || findings.length === 0 ? (
                <EmptyState
                  icon={Gauge}
                  compact
                  title={statusSet === "active" ? "No open findings" : "No findings match these filters"}
                  description={!brief?.coverage ? "No health evaluation has run yet, so there is nothing to report either way. Run an evaluation." : `No qualifying issues were detected from the available evidence${brief.coverage.unknownCount ? `; ${brief.coverage.unknownCount} check(s) could not be evaluated for lack of evidence and are unknown, not healthy` : ""}.`}
                  action={!brief?.coverage ? <button onClick={evaluateNow} className="btn-secondary btn-sm">Evaluate now</button> : undefined}
                />
              ) : (
                <ul className="divide-y divide-border-subtle overflow-hidden rounded-lg border border-border" data-testid="findings-list">
                  {findings.map((f) => (
                    <li key={f.id}>
                      <button onClick={() => select(f.id)} aria-current={selected === f.id} className={cn("flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-bg-hover", selected === f.id && "bg-bg-raised")} data-finding={f.ruleId} data-status={f.status}>
                        <span className={cn("dot mt-1.5", SEV_DOT[f.severity])} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-text">{f.title}</span>
                          <span className="mono block truncate text-2xs text-text-faint">{f.category} · {f.resourceLabel} · seen {f.occurrences}× · {timeAgo(f.lastObservedAt)}</span>
                        </span>
                        <span className="flex shrink-0 flex-col items-end gap-1">
                          <span className="flex gap-1"><SeverityBadge severity={f.severity} />{f.requiresHuman && <Badge tone="warning">person</Badge>}</span>
                          <span className="flex gap-1"><CertaintyBadge certainty={f.certainty} />{f.status !== "OPEN" && <Badge>{f.status.toLowerCase()}</Badge>}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {brief && brief.unknown.length > 0 && (
                <details className="mt-3 rounded-md border border-border px-3 py-2 text-xs">
                  <summary className="cursor-pointer text-text-muted">{brief.coverage?.unknownCount} check(s) with insufficient evidence (unknown — not healthy)</summary>
                  <ul className="mt-2 space-y-0.5">
                    {brief.unknown.map((u, i) => <li key={i} className="mono text-2xs text-text-faint">{u.ruleId} · {u.resource} — {u.reason}</li>)}
                  </ul>
                </details>
              )}
            </div>
            {selected && (
              <div className="xl:sticky xl:top-4 xl:h-[calc(100vh-7rem)]">
                <FindingInspector key={selected} companyId={id} findingId={selected} version={tick} onClose={() => select(null)} onChanged={refreshAll} />
              </div>
            )}
          </div>

          {/* Recent operational events */}
          <Section title="Recent operational events" className="mt-6">
            {!events ? <Skeleton className="h-24" /> : events.length === 0 ? <p className="text-sm text-text-muted">No operational events in this range.</p> : (
              <ol className="divide-y divide-border-subtle rounded-lg border border-border text-xs" data-testid="ops-events">
                {events.slice(0, 25).map((e) => (
                  <li key={e.id} className="flex items-center gap-3 px-3 py-1.5">
                    <span className="mono w-16 shrink-0 text-text-faint">{timeAgo(e.createdAt)}</span>
                    <span className={cn("dot", SEV_DOT[e.severity ?? "low"] ?? "bg-text-faint")} />
                    <span className="mono w-16 shrink-0 text-text-faint">{e.source}</span>
                    <span className="min-w-0 flex-1 truncate text-text">{e.message}</span>
                    {e.resolution && <span className="mono text-2xs text-text-faint">{e.resolution}</span>}
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
