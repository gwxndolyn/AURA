"use client";

import { Fragment, use, useState } from "react";
import { Rocket, Loader2, CheckCircle2, XCircle, Circle, ChevronDown } from "lucide-react";
import { useQuery, useMutation } from "@/hooks/useApi";
import { StatusBadge, EmptyState, ErrorState, Skeleton, PageHeader, Badge } from "@/components/ui/primitives";
import { cn, timeAgo, parseJSON } from "@/lib/utils";
import { useApp } from "@/lib/store";

interface Deployment {
  id: string;
  env: string;
  version: string;
  commit: string;
  status: string;
  stage: string;
  stages: string;
  durationMs: number;
  createdAt: string;
}

interface ChangeSummary {
  files: number;
  additions: number;
  deletions: number;
  tests: { passed: number; total: number };
  risk: string;
  criticalVulns: number;
}

interface DeployResult {
  gated?: boolean;
  success?: boolean;
}

const STAGE_ORDER = ["BUILD", "TEST", "SECURITY_SCAN", "DEPLOY", "HEALTH_CHECK"];
const ENVS = ["staging", "development", "production"] as const;

export default function DeploymentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, loading, error, refetch } = useQuery<Deployment[]>(`/api/companies/${id}/deploy`, 4000);
  const { mutate, loading: busy } = useMutation<{ env?: string; decision?: string }, DeployResult>();
  const { toast } = useApp();
  const [env, setEnv] = useState<(typeof ENVS)[number]>("staging");
  const [open, setOpen] = useState<string | null>(null);

  async function deploy() {
    try {
      const res = await mutate(`/api/companies/${id}/deploy`, { env });
      refetch();
      if (res?.gated) toast({ title: `${env} release is waiting for approval`, description: "Review the change summary and approve or reject it.", level: "warning" });
      else toast({ title: res?.success ? `Deployed to ${env}` : `Deploy to ${env} failed`, level: res?.success ? "success" : "danger" });
    } catch (e) {
      toast({ title: "Deploy failed", description: (e as Error).message, level: "danger" });
    }
  }

  async function resolve(deploymentId: string, decision: "approve" | "reject") {
    try {
      await mutate(`/api/companies/${id}/deploy/${deploymentId}/approve`, { decision });
      refetch();
      toast({ title: decision === "approve" ? "Approved — pipeline running" : "Release rejected", level: decision === "approve" ? "success" : "warning" });
    } catch (e) {
      toast({ title: "Action failed", description: (e as Error).message, level: "danger" });
    }
  }

  const pending = data?.filter((d) => d.status === "PENDING_APPROVAL") ?? [];
  const history = data?.filter((d) => d.status !== "PENDING_APPROVAL") ?? [];
  const success = history.filter((d) => d.status === "SUCCESS").length;

  return (
    <div className="page">
      <PageHeader
        title="Deployments"
        description="Simulated release pipeline: build → test → security scan → deploy → health check. Production releases always require approval."
        meta={<Badge>simulated pipeline</Badge>}
        actions={
          <>
            <div className="segmented" role="group" aria-label="Target environment">
              {ENVS.map((e) => (
                <button key={e} data-active={env === e} onClick={() => setEnv(e)}>{e}</button>
              ))}
            </div>
            <button onClick={deploy} disabled={busy} className="btn-primary">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
              Deploy to {env}
            </button>
          </>
        }
      />

      {pending.length > 0 && (
        <section className="mb-5 space-y-2" aria-label="Awaiting approval">
          {pending.map((d) => {
            const summary = parseJSON<{ summary?: ChangeSummary }>(d.stages, {}).summary;
            return (
              <div key={d.id} className="rounded-lg border border-warning/35 bg-warning/[0.04]">
                <div className="flex flex-wrap items-center gap-2 border-b border-warning/20 px-4 py-2.5">
                  <span className="text-sm font-medium text-warning">Approval required</span>
                  <span className="mono text-sm">{d.version}</span>
                  <span className="text-xs text-text-muted">→ {d.env}</span>
                  <span className="ml-auto text-2xs text-text-faint">requested {timeAgo(d.createdAt)}</span>
                </div>
                {summary && (
                  <dl className="grid grid-cols-2 gap-4 px-4 py-3 text-sm sm:grid-cols-4">
                    <div><dt className="metric-label">Change size</dt><dd className="mono mt-1">{summary.files} files <span className="text-success">+{summary.additions}</span> <span className="text-danger">−{summary.deletions}</span></dd></div>
                    <div><dt className="metric-label">Tests</dt><dd className="mono mt-1">{summary.tests.passed}/{summary.tests.total} passed</dd></div>
                    <div><dt className="metric-label">Critical vulns</dt><dd className={cn("mono mt-1", summary.criticalVulns ? "text-danger" : "")}>{summary.criticalVulns}</dd></div>
                    <div><dt className="metric-label">Risk</dt><dd className="mt-1"><StatusBadge status={summary.risk} /></dd></div>
                  </dl>
                )}
                <div className="flex flex-wrap items-center gap-2 border-t border-warning/20 px-4 py-2.5">
                  <span className="mr-auto basis-full text-xs text-text-muted sm:basis-auto">Approving runs the full pipeline against {d.env}. Rejecting cancels this release.</span>
                  <button onClick={() => resolve(d.id, "reject")} disabled={busy} className="btn-ghost">
                    <XCircle className="h-3.5 w-3.5" /> Reject
                  </button>
                  <button onClick={() => resolve(d.id, "approve")} disabled={busy} className="btn-secondary">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Approve & deploy
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {error && !data ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : loading && !data ? (
        <div className="space-y-1">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-11" />)}</div>
      ) : history.length === 0 ? (
        <EmptyState icon={Rocket} title="No releases yet" description="Pick an environment and deploy. Each run records every pipeline stage with its duration and result." />
      ) : (
        <>
          <div className="mb-2 flex items-center gap-3 text-xs text-text-muted">
            <span><span className="mono text-text">{history.length}</span> releases</span>
            <span><span className="mono text-text">{success}</span> succeeded</span>
            <span><span className="mono text-danger">{history.length - success}</span> failed or rolled back</span>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="table min-w-[820px]">
              <thead className="bg-bg-raised">
                <tr><th className="w-6" /><th>Version</th><th>Env</th><th>Commit</th><th>Status</th><th>Pipeline</th><th className="text-right">Duration</th><th>When</th></tr>
              </thead>
              <tbody>
                {history.map((d) => {
                  const stages = parseJSON<{ name: string; status: string; durationMs: number; log?: string }[]>(d.stages, []);
                  const expanded = open === d.id;
                  return (
                    <Fragment key={d.id}>
                      <tr data-interactive="true" onClick={() => setOpen(expanded ? null : d.id)} aria-expanded={expanded}>
                        <td><ChevronDown className={cn("h-3.5 w-3.5 text-text-faint transition-transform", !expanded && "-rotate-90")} /></td>
                        <td className="mono">{d.version}</td>
                        <td className="text-xs text-text-muted">{d.env}</td>
                        <td className="mono text-xs text-text-faint">{d.commit}</td>
                        <td><StatusBadge status={d.status} /></td>
                        <td>
                          <div className="flex gap-0.5" aria-label="Pipeline stages">
                            {STAGE_ORDER.map((n) => {
                              const s = stages.find((x) => x.name === n);
                              return <span key={n} title={`${n.replace(/_/g, " ").toLowerCase()}: ${s?.status?.toLowerCase() ?? "not run"}`} className={cn("h-1.5 w-6 rounded-full", s?.status === "SUCCESS" ? "bg-success" : s?.status === "FAILED" ? "bg-danger" : "bg-border-strong")} />;
                            })}
                          </div>
                        </td>
                        <td className="mono text-right text-xs text-text-muted">{(d.durationMs / 1000).toFixed(1)}s</td>
                        <td className="mono text-xs text-text-faint">{timeAgo(d.createdAt)}</td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td />
                          <td colSpan={7} className="pb-3">
                            <ol className="well divide-y divide-border-subtle">
                              {STAGE_ORDER.map((n) => {
                                const s = stages.find((x) => x.name === n);
                                const Icon = s?.status === "SUCCESS" ? CheckCircle2 : s?.status === "FAILED" ? XCircle : Circle;
                                return (
                                  <li key={n} className="mono flex items-center gap-3 px-3 py-1.5 text-xs">
                                    <Icon className={cn("h-3.5 w-3.5", s?.status === "SUCCESS" ? "text-success" : s?.status === "FAILED" ? "text-danger" : "text-text-faint")} />
                                    <span className="w-28 text-text">{n.replace(/_/g, " ").toLowerCase()}</span>
                                    <span className="w-16 text-text-muted">{s?.status?.toLowerCase() ?? "skipped"}</span>
                                    <span className="text-text-faint">{s ? `${s.durationMs}ms` : "—"}</span>
                                    {s?.log && <span className="truncate text-text-muted">{s.log}</span>}
                                  </li>
                                );
                              })}
                            </ol>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
