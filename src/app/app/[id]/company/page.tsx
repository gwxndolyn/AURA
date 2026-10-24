"use client";

import { use, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { useQuery } from "@/hooks/useApi";
import { CeoDialog } from "@/components/dashboard/ceo-dialog";
import { Skeleton, PageHeader, ErrorState, Badge } from "@/components/ui/primitives";
import { cn, formatCurrency } from "@/lib/utils";

const OrgGraph = dynamic(() => import("@/components/company/org-graph").then((m) => m.OrgGraph), {
  ssr: false,
  loading: () => <div className="skeleton h-[460px] rounded-none" />,
});

interface Overview {
  company: { name: string; mission: string; industry: string; cash: number; revenue: number; expenses: number; valuation: number; reputation: number; autonomy: string; isDemo: boolean };
  agents: { key: string; name: string; role: string; avatar: string; color: string; status: string }[];
  security: { total: number; categories: { key: string; label: string; score: number; evidence: string }[] };
}

export default function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, loading, error, refetch } = useQuery<Overview>(`/api/companies/${id}/overview`, 8000);
  const [ceo, setCeo] = useState(false);
  const c = data?.company;

  return (
    <div className="page">
      <PageHeader
        title={c?.name ?? "Company"}
        description={c?.mission}
        meta={c && <><Badge>{c.industry}</Badge><Badge>autonomy · {c.autonomy.toLowerCase()}</Badge>{c.isDemo && <Badge>seeded demo data</Badge>}</>}
        actions={<><Link href={`/app/${id}/twin`} className="btn-secondary">Open company twin</Link><button onClick={() => setCeo(true)} className="btn-secondary"><MessageSquare className="h-3.5 w-3.5" /> Ask the CEO</button></>}
      />
      {error && !data && <ErrorState message={error} onRetry={refetch} />}

      <dl className="mb-5 grid grid-cols-2 divide-x divide-border overflow-hidden rounded-lg border border-border md:grid-cols-5">
        {[
          ["Valuation", c && formatCurrency(c.valuation), "model: revenue × 6 + customers"],
          ["Revenue / day", c && formatCurrency(c.revenue), "simulated"],
          ["Expenses / day", c && formatCurrency(c.expenses), "infra + headcount"],
          ["Net / day", c && formatCurrency(c.revenue - c.expenses), c && c.revenue - c.expenses < 0 ? "burning cash" : "profitable"],
          ["Reputation", c && `${Math.round(c.reputation)}/100`, "customer sentiment"],
        ].map(([k, v, h]) => (
          <div key={k as string} className="px-3 py-2.5">
            <dt className="metric-label">{k}</dt>
            <dd className={cn("mono mt-1 text-lg", k === "Net / day" && c && c.revenue - c.expenses < 0 && "text-warning")}>{v ?? "—"}</dd>
            <div className="text-2xs text-text-faint">{h}</div>
          </div>
        ))}
      </dl>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="overflow-hidden rounded-lg border border-border">
          <div className="flex h-9 items-center border-b border-border bg-bg-raised px-3"><h2 className="section-title">Organization</h2></div>
          <div className="bg-bg-inset"><OrgGraph agents={data?.agents ?? []} /></div>
        </section>

        <section className="overflow-hidden rounded-lg border border-border">
          <div className="flex h-9 items-center justify-between border-b border-border bg-bg-raised px-3">
            <h2 className="section-title">Security posture</h2>
            <span className="mono text-sm">{data?.security.total ?? "—"}<span className="text-2xs text-text-faint">/100</span></span>
          </div>
          {loading && !data ? (
            <div className="space-y-2 p-3">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {data?.security.categories.map((cat) => (
                <li key={cat.key} className="px-3 py-2">
                  <div className="flex items-center justify-between text-sm">
                    <span>{cat.label}</span>
                    <span className={cn("mono", cat.score < 50 ? "text-danger" : cat.score < 80 ? "text-warning" : "text-text")}>{Math.round(cat.score)}</span>
                  </div>
                  <div className="mt-1 h-0.5 rounded-full bg-bg-elevated"><div className={cn("h-0.5 rounded-full", cat.score < 50 ? "bg-danger" : cat.score < 80 ? "bg-warning" : "bg-success")} style={{ width: `${cat.score}%` }} /></div>
                  <div className="mt-1 text-2xs text-text-faint">{cat.evidence}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <CeoDialog companyId={id} open={ceo} onClose={() => setCeo(false)} />
    </div>
  );
}
