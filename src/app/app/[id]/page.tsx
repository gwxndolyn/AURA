"use client";

import Link from "next/link";
import { use, useEffect } from "react";
import { ArrowRight, Boxes, CircleAlert, GitPullRequest, Loader2, Sparkles } from "lucide-react";
import { useQuery } from "@/hooks/useApi";
import { useLiveEvents } from "@/hooks/useLiveEvents";
import { PageHeader, Skeleton, ErrorState, Badge, EmptyState } from "@/components/ui/primitives";
import { timeAgo } from "@/lib/utils";

interface Product { id: string; title: string; phaseLabel: string; status: string; scopeApproved: boolean; planningStatus?: string; createdAt: string; blocked: number; progress: { verified: number; executable: number } }
interface Build { id: string; productId: string; itemKey: string; status: string; phase: string; branch: string; attempt: number; failure: string; createdAt: string; finishedAt: string | null; costUsd: number }
interface Billing { plan: { name: string; limits: { buildsPerMonth: number; aiBudgetUsdPerMonth: number; products: number } }; usage: { builds: number; aiCostUsd: number; products: number } }
interface AiStatus { mode: string; sandbox: string }

/** Workspace home: your products, what the team is doing now, what needs you, and this month's usage — all from persisted state. */
export default function Home({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: products, error, refetch } = useQuery<Product[]>(`/api/companies/${id}/products`, 8000);
  const { data: builds, refetch: refetchBuilds } = useQuery<Build[]>(`/api/companies/${id}/builds`, 5000);
  const { data: billing } = useQuery<Billing>(`/api/companies/${id}/billing`, 30000);
  const { data: ai } = useQuery<AiStatus>(`/api/ai/status`, 60000);
  const { version } = useLiveEvents(id);
  useEffect(() => {
    if (version > 0) {
      refetch();
      refetchBuilds();
    }
  }, [version, refetch, refetchBuilds]);

  if (error && !products) return <div className="page"><ErrorState message={error} onRetry={refetch} /></div>;
  const running = (builds ?? []).filter((b) => ["QUEUED", "RUNNING"].includes(b.status));
  const needsYou = [
    ...(products ?? []).filter((p) => !p.scopeApproved && p.planningStatus === "READY").map((p) => ({ href: `/app/${id}/products/${p.id}?tab=approvals`, text: `Approve the scope for ${p.title}` })),
    ...(products ?? []).filter((p) => p.blocked).map((p) => ({ href: `/app/${id}/products/${p.id}?tab=backlog`, text: `${p.blocked} blocked task(s) in ${p.title}` })),
    ...(builds ?? []).filter((b) => b.status === "BLOCKED").slice(0, 3).map((b) => ({ href: `/app/${id}/products/${b.productId}?tab=runs&run=${b.id}`, text: `Run for ${b.itemKey} is blocked: ${b.failure.slice(0, 80)}` })),
  ];
  const nameOf = (pid: string) => products?.find((p) => p.id === pid)?.title ?? "product";

  return (
    <div className="page" data-testid="workspace-home">
      <PageHeader title="Home" description="Your products, what the team is working on, and what needs you." actions={<Link href={`/app/${id}/products`} className="btn-primary btn-sm"><Sparkles className="h-3.5 w-3.5" /> New product</Link>} />
      {ai && (ai.mode !== "live" || ai.sandbox !== "docker") && (
        <div role="status" className="mb-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
          <CircleAlert className="mt-0.5 h-4 w-4 text-warning" />
          <span>{ai.mode !== "live" ? "No AI provider is configured on this server, so planning and engineering runs cannot start. " : ""}{ai.sandbox !== "docker" ? "The execution sandbox is offline, so engineering runs will wait until it is available." : ""}</span>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          <section>
            <h2 className="section-title mb-2">Products</h2>
            {!products ? <Skeleton className="h-28" /> : products.length === 0 ? (
              <EmptyState icon={Boxes} title="No products yet" description="Describe what you want to build. The product manager drafts a plan for you to review." action={<Link href={`/app/${id}/products`} className="btn-primary btn-sm">Describe your first product <ArrowRight className="h-3.5 w-3.5" /></Link>} />
            ) : (
              <ul className="divide-y divide-border-subtle rounded-lg border border-border">
                {products.map((p) => (
                  <li key={p.id}>
                    <Link href={`/app/${id}/products/${p.id}`} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-bg-raised">
                      <span className="font-medium">{p.title}</span>
                      {p.planningStatus && p.planningStatus !== "READY" ? <Badge tone={p.planningStatus === "FAILED" ? "danger" : "info"}>{p.planningStatus === "FAILED" ? "planning failed" : "planning…"}</Badge> : <Badge>{p.phaseLabel}</Badge>}
                      <span className="mono ml-auto text-xs text-text-muted">{p.progress.executable ? `${p.progress.verified}/${p.progress.executable} verified` : "—"}</span>
                      <span className="text-2xs text-text-faint">{timeAgo(p.createdAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2 className="section-title mb-2">Engineering runs</h2>
            {!builds ? <Skeleton className="h-24" /> : builds.length === 0 ? <p className="text-sm text-text-muted">No runs yet. Runs start when you approve a product's scope and press Run team.</p> : (
              <ul className="divide-y divide-border-subtle rounded-lg border border-border text-sm" data-testid="runs-list">
                {builds.slice(0, 12).map((b) => (
                  <li key={b.id}>
                    <Link href={`/app/${id}/products/${b.productId}?tab=runs&run=${b.id}`} className="flex items-center gap-3 px-3 py-2 hover:bg-bg-raised">
                      {["QUEUED", "RUNNING"].includes(b.status) ? <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" /> : <span className={`h-2 w-2 rounded-full ${b.status === "VERIFIED" ? "bg-success" : b.status === "FAILED" ? "bg-danger" : b.status === "BLOCKED" ? "bg-warning" : "bg-text-faint"}`} />}
                      <span className="mono text-xs text-text-faint">{b.itemKey}</span>
                      <span className="truncate">{nameOf(b.productId)}</span>
                      <span className="ml-auto text-xs text-text-muted">{b.status === "RUNNING" ? b.phase : b.status.toLowerCase()}</span>
                      <span className="text-2xs text-text-faint">{timeAgo(b.finishedAt ?? b.createdAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <aside className="space-y-5">
          <section className="rounded-lg border border-border p-3">
            <h2 className="section-title mb-2">Needs you</h2>
            {needsYou.length === 0 ? <p className="text-xs text-text-muted">Nothing right now.</p> : <ul className="space-y-1.5 text-sm">{needsYou.map((n, i) => <li key={i}><Link href={n.href} className="hover:underline">{n.text}</Link></li>)}</ul>}
          </section>
          <section className="rounded-lg border border-border p-3">
            <h2 className="section-title mb-2">Working now</h2>
            {running.length === 0 ? <p className="text-xs text-text-muted">The team is idle.</p> : <ul className="space-y-1 text-xs">{running.map((b) => <li key={b.id}><span className="mono">{b.itemKey}</span> · {b.phase}{b.attempt ? ` · attempt ${b.attempt + 1}` : ""}</li>)}</ul>}
            <Link href={`/app/${id}/office`} className="mt-2 inline-block text-xs text-text-muted underline">Open the office</Link>
          </section>
          {billing && (
            <section className="rounded-lg border border-border p-3 text-xs">
              <h2 className="section-title mb-2">This month · {billing.plan.name}</h2>
              <Meter label="Engineering runs" used={billing.usage.builds} limit={billing.plan.limits.buildsPerMonth} />
              <Meter label="AI usage" used={billing.usage.aiCostUsd} limit={billing.plan.limits.aiBudgetUsdPerMonth} money />
              <Meter label="Products" used={billing.usage.products} limit={billing.plan.limits.products} />
              <Link href={`/app/${id}/settings?tab=billing`} className="mt-2 inline-flex items-center gap-1 text-text-muted underline"><GitPullRequest className="hidden" />Plan & billing</Link>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function Meter({ label, used, limit, money }: { label: string; used: number; limit: number; money?: boolean }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="mb-2">
      <div className="flex justify-between"><span className="text-text-muted">{label}</span><span className="mono">{money ? `$${used.toFixed(2)} / $${limit}` : `${Math.round(used)} / ${limit}`}</span></div>
      <div className="mt-1 h-1.5 rounded-full bg-bg-inset" role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><div className={`h-1.5 rounded-full ${pct >= 90 ? "bg-danger" : "bg-brand"}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
