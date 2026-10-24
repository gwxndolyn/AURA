"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { Code2, ListChecks, Rocket, Boxes } from "lucide-react";
import { useQuery } from "@/hooks/useApi";
import { useLiveEvents } from "@/hooks/useLiveEvents";
import { PageHeader, ErrorState, Skeleton, Badge } from "@/components/ui/primitives";
import { OfficeView } from "@/components/office/office-view";
import { AgentInspector, LocationInspector, type ActivityLine } from "@/components/office/agent-inspector";
import { PixelAvatar, ACTIVITY_DOT } from "@/components/office/office-2d";
import { mapOfficeState, ACTIVITY_LABEL } from "@/lib/office/state";
import type { OfficeSnapshot } from "@/lib/office/live";
import type { LocationId } from "@/lib/office/layout";
import { cn, timeAgo } from "@/lib/utils";

/**
 * Living office for a real workspace. Character state is derived from
 * persisted mission tasks, product backlog items/artifacts and recorded
 * handoffs/findings (see src/lib/office/state.ts). The office is a view; all
 * work happens in the engineering views linked from every panel.
 */
export default function OfficePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const base = `/app/${id}`;
  const { data, error, refetch } = useQuery<OfficeSnapshot>(`/api/companies/${id}/office`, 15000);
  const { version } = useLiveEvents(id);
  useEffect(() => {
    if (version > 0) refetch();
  }, [version, refetch]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loc, setLoc] = useState<LocationId | null>(null);

  const visual = useMemo(() => (data ? mapOfficeState({ agents: data.agents, tasks: data.tasks, work: data.work, interactions: data.interactions, now: Date.parse(data.now) }) : []), [data]);
  const recentInteractions = useMemo(() => (data ? data.interactions.filter((i) => Date.parse(data.now) - Date.parse(i.at) < 10 * 60_000) : []), [data]);

  const activityFor = (key: string): ActivityLine[] => {
    if (!data) return [];
    const runs = data.runs.filter((r) => r.agentKey === key).map((r) => ({ text: `${r.taskKey}: ${r.outcome || r.status.toLowerCase()}${r.errorCategory ? ` (${r.errorCategory})` : ""}`, at: r.startedAt, href: `${base}/missions/${r.missionId}`, tone: r.status === "FAILED" ? ("bad" as const) : r.status === "SUCCEEDED" ? ("ok" as const) : ("neutral" as const) }));
    const inter = data.interactions.filter((i) => i.from === key || i.to.includes(key)).map((i) => ({ text: i.text, at: i.at, href: i.href ? `${base}${i.href}` : undefined, tone: i.kind === "finding" ? ("bad" as const) : ("neutral" as const) }));
    return [...runs, ...inter].sort((a, b) => b.at.localeCompare(a.at));
  };

  if (error && !data) return <div className="page"><ErrorState message={error} onRetry={refetch} /></div>;
  const sel = visual.find((v) => v.key === selected);
  const busy = visual.filter((v) => v.activity !== "idle");

  return (
    <div className="page" data-testid="live-office">
      <PageHeader
        title="Office"
        description="Your AI engineering team, live. Positions and activities come from persisted mission tasks, product work and recorded handoffs — nothing here is animated without a record behind it."
        meta={<><Badge tone="success">live data</Badge><span className="text-2xs text-text-faint">{data ? `updated ${timeAgo(data.now)}` : "loading"}</span></>}
        actions={
          <div className="flex flex-wrap gap-1.5">
            <Link href={`${base}/missions`} className="btn-secondary btn-sm"><ListChecks className="h-3.5 w-3.5" /> Missions</Link>
            <Link href={`${base}/code`} className="btn-secondary btn-sm"><Code2 className="h-3.5 w-3.5" /> Code &amp; reviews</Link>
            <Link href={`${base}/products`} className="btn-secondary btn-sm"><Boxes className="h-3.5 w-3.5" /> Products</Link>
          </div>
        }
      />
      {!data ? (
        <Skeleton className="h-[560px]" />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <OfficeView agents={visual} interactions={recentInteractions} selected={selected} onSelect={(k) => { setSelected(k); if (k) setLoc(null); }} selectedLocation={loc} onSelectLocation={(l) => { setLoc(l); if (l) setSelected(null); }} height={600} label="Live office" />
          <aside className="rounded-lg border border-border p-3" aria-label="Office details">
            {sel ? (
              <AgentInspector agent={sel} activity={activityFor(sel.key)} base={base} onClose={() => setSelected(null)} />
            ) : loc ? (
              <LocationInspector id={loc} agents={visual} onSelectAgent={setSelected} onClose={() => setLoc(null)} extra={loc === "qa" ? <ExecRuns data={data} base={base} /> : loc === "deploy" ? <Approvals data={data} base={base} /> : null} />
            ) : (
              <div className="space-y-3 text-sm">
                <div>
                  <h3 className="font-medium">Team status</h3>
                  <p className="text-xs text-text-muted">{busy.length === 0 ? "Nobody is working right now. Start a mission or a product to put the team to work." : `${busy.length} of ${visual.length} teammates have active work.`}</p>
                </div>
                <ul className="space-y-1" data-testid="team-list">
                  {[...visual].sort((a, b) => Number(a.activity === "idle") - Number(b.activity === "idle") || b.queued - a.queued || a.name.localeCompare(b.name)).map((v) => (
                    <li key={v.key}>
                      <button onClick={() => setSelected(v.key)} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-bg-hover" data-agent-row={v.key}>
                        <PixelAvatar agentKey={v.key} size={22} />
                        <span className="w-28 shrink-0 truncate font-medium">{v.name}</span>
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", ACTIVITY_DOT[v.activity])} />
                        <span className="w-24 shrink-0 text-text-muted">{ACTIVITY_LABEL[v.activity]}</span>
                        <span className="truncate text-text-faint">{v.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {data.approvals.length > 0 && <Approvals data={data} base={base} />}
                {busy.length === 0 && (
                  <div className="rounded-md border border-dashed border-border p-3 text-xs text-text-muted">
                    <p>Try the guided workflow: import the sample checkout project in <Link className="underline" href={`${base}/code`}>Code</Link>, then ask the team to fix its failing validation test. You can watch it happen here.</p>
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      )}
      <p className="mt-3 flex items-center gap-1.5 text-2xs text-text-faint"><Rocket className="h-3 w-3" /> The release station shows human approval gates. AURA&apos;s deployment pipeline is simulated; nothing ships to a real host.</p>
    </div>
  );
}

function ExecRuns({ data, base }: { data: OfficeSnapshot; base: string }) {
  if (!data.execRuns.length) return <p className="text-xs text-text-muted">No workspace checks in the last 24 hours. <Link className="underline" href={`${base}/code`}>Run tests</Link></p>;
  return (
    <div>
      <div className="metric-label mb-1">Workspace checks (24h)</div>
      <ul className="space-y-0.5 text-xs">
        {data.execRuns.map((r) => (
          <li key={r.id} className="flex gap-2"><span className={r.status === "PASSED" ? "text-success" : r.status === "FAILED" ? "text-danger" : "text-text-faint"}>{r.status.toLowerCase()}</span><span className="mono text-text-muted">{r.check}</span>{r.total !== null && <span className="mono text-text-faint">{r.passed}/{r.total}</span>}<span className="ml-auto text-text-faint">{timeAgo(r.createdAt)}</span></li>
        ))}
      </ul>
    </div>
  );
}

function Approvals({ data, base }: { data: OfficeSnapshot; base: string }) {
  if (!data.approvals.length) return <p className="text-xs text-text-muted">No approvals waiting.</p>;
  return (
    <div>
      <div className="metric-label mb-1">Waiting for you</div>
      <ul className="space-y-0.5 text-xs">
        {data.approvals.map((a) => <li key={a.id}><Link className="hover:underline" href={`${base}/missions/${a.missionId}`}>{a.action}</Link> <span className="text-text-faint">{timeAgo(a.at)}</span></li>)}
      </ul>
    </div>
  );
}
