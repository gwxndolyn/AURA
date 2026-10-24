"use client";

import { use, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Swords, Loader2 } from "lucide-react";
import { useQuery, useMutation } from "@/hooks/useApi";
import { useLiveEvents } from "@/hooks/useLiveEvents";
import { ActivityFeed } from "@/components/dashboard/activity-feed";
import { PageHeader, SimulatedNotice, ErrorState } from "@/components/ui/primitives";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const NetworkGraph = dynamic(() => import("@/components/cyber/network-graph").then((m) => m.NetworkGraph), {
  ssr: false,
  loading: () => <div className="skeleton h-[440px] rounded-none" />,
});

interface Overview {
  nodes: { id: string; key: string; label: string; kind: string; status: string; cpu: number; latencyMs: number; errorRate: number; posX: number; posY: number }[];
  security: { total: number };
  activeIncidents: number;
  openFindings: number;
}

const SCENARIOS = [
  { type: "SQL Injection", target: "Customer API" },
  { type: "Insecure Direct Object Reference", target: "User API" },
  { type: "Weak Authentication", target: "Auth Service" },
  { type: "Reflected XSS", target: "Application" },
  { type: "Exposed Debug Endpoint", target: "Admin Service" },
];

export default function CyberRangePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, refetch } = useQuery<Overview>(`/api/companies/${id}/overview`, 4000);
  const { events, connected, version } = useLiveEvents(id);
  const { mutate, loading } = useMutation<{ attackType?: string }, unknown>();
  const { toast } = useApp();
  const [scenario, setScenario] = useState<string>("");

  useEffect(() => {
    if (version > 0) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  async function run() {
    try {
      await mutate(`/api/companies/${id}/attack`, { attackType: scenario || undefined });
      toast({ title: "Exercise complete", description: "Detection, containment and patch steps are in the event log and Incidents.", level: "success" });
    } catch (e) {
      toast({ title: "Exercise failed", description: (e as Error).message, level: "danger" });
    }
  }

  const unhealthy = data?.nodes.filter((n) => n.status !== "HEALTHY") ?? [];
  const rangeEvents = events.filter((e) => ["ATTACK_STARTED", "ATTACK_DETECTED", "INCIDENT_CREATED", "INCIDENT_RESOLVED", "VULNERABILITY_FOUND", "VULNERABILITY_PATCHED"].includes(e.type) || ["red-team", "blue-team", "security-engineer"].includes(e.actor ?? ""));

  return (
    <div className="page">
      <PageHeader
        title="Cyber Range"
        description="Red team (Ghost) runs scripted attack scenarios against in-process toy services; blue team (Shield) detects and contains; engineers patch; QA verifies."
        actions={
          <>
            <label htmlFor="scenario" className="sr-only">Scenario</label>
            <select id="scenario" value={scenario} onChange={(e) => setScenario(e.target.value)} className="input h-8 w-64">
              <option value="">Random scenario</option>
              {SCENARIOS.map((s) => (
                <option key={s.type} value={s.type}>{s.type} → {s.target}</option>
              ))}
            </select>
            <button onClick={run} disabled={loading} className="btn-secondary">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Swords className="h-3.5 w-3.5" />}
              {loading ? "Running exercise…" : "Run exercise"}
            </button>
          </>
        }
      />

      <div className="mb-4">
        <SimulatedNotice>Isolated simulation. No network traffic leaves this process and no real system is targeted.</SimulatedNotice>
      </div>

      {error && !data && <ErrorState message={error} onRetry={refetch} />}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <section className="overflow-hidden rounded-lg border border-border">
          <div className="flex h-9 items-center gap-4 border-b border-border bg-bg-raised px-3 text-xs">
            <h2 className="section-title">Topology</h2>
            <span className="text-text-muted">
              Threat <span className={cn("mono", data?.activeIncidents ? "text-danger" : "text-text")}>{data ? (data.activeIncidents ? `elevated · ${data.activeIncidents} active` : "nominal") : "…"}</span>
            </span>
            <span className="text-text-muted">Security score <span className="mono text-text">{data?.security.total ?? "…"}</span><span className="text-text-faint">/100</span></span>
            <span className="text-text-muted">Unhealthy <span className={cn("mono", unhealthy.length ? "text-warning" : "text-text")}>{unhealthy.length}</span></span>
          </div>
          <div className="bg-bg-inset">
            <NetworkGraph nodes={data?.nodes ?? []} />
          </div>
        </section>

        <div className="h-[477px] overflow-hidden rounded-lg border border-border">
          <ActivityFeed events={rangeEvents} connected={connected} title="Range activity" className="h-full" />
        </div>
      </div>
    </div>
  );
}
