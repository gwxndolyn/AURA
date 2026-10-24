"use client";

import { Suspense, use, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Trash2, Loader2, RotateCcw, Github, CreditCard, ExternalLink } from "lucide-react";
import { useQuery, useMutation, fetchJSON } from "@/hooks/useApi";
import { useApp } from "@/lib/store";
import { PageHeader, Badge } from "@/components/ui/primitives";
import { PLANS, PLAN_ORDER } from "@/lib/billing/plans";
import { cn } from "@/lib/utils";

interface AiStatus { mode: string; models: Record<string, string>; sandbox: string }
interface Billing {
  plan: { id: string; name: string; limits: { products: number; buildsPerMonth: number; aiBudgetUsdPerMonth: number; sandboxMinutesPerMonth: number; concurrentBuilds: number; seats: number } };
  subscribedPlan: string; status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; hasCustomer: boolean;
  usage: { since: string; builds: number; aiCostUsd: number; tokensIn: number; tokensOut: number; sandboxMinutes: number; products: number };
  billing: { configured: boolean; testMode: boolean; missing: string[] };
  canManage: boolean;
}
interface Github { configured: boolean; missing: string[]; installUrl: string | null; canConnect: boolean; installations: { id: string; account: string; status: string; connectedBy: string; createdAt: string }[] }

const TABS = ["general", "billing", "integrations", "account"] as const;
type Tab = (typeof TABS)[number];

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <Suspense fallback={<div className="page" />}><Settings params={params} /></Suspense>;
}

function Settings({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const search = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>((search.get("tab") as Tab) ?? "general");
  const { toast } = useApp();
  useEffect(() => {
    const c = search.get("checkout");
    if (c === "success") toast({ title: "Checkout complete", description: "Your plan updates as soon as the payment provider confirms it (usually a few seconds).", level: "success" });
    const g = search.get("github");
    if (g === "connected") toast({ title: "GitHub connected", level: "success" });
    else if (g) toast({ title: "GitHub connection failed", description: search.get("reason") ?? g, level: "danger" });
  }, [search, toast]);
  const go = (t: Tab) => {
    setTab(t);
    router.replace(`/app/${id}/settings?tab=${t}`, { scroll: false });
  };
  return (
    <div className="page max-w-[900px]">
      <PageHeader title="Settings" description="Workspace, plan and billing, integrations, and your account." />
      <div className="tabs mb-5" role="tablist">{TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} data-active={tab === t} onClick={() => go(t)} className="tab capitalize">{t}</button>)}</div>
      {tab === "general" && <General id={id} />}
      {tab === "billing" && <BillingTab id={id} upgrade={search.get("upgrade")} />}
      {tab === "integrations" && <Integrations id={id} />}
      {tab === "account" && <Account />}
    </div>
  );
}

function General({ id }: { id: string }) {
  const router = useRouter();
  const { toast, setCompanyId } = useApp();
  const { data: ai } = useQuery<AiStatus>("/api/ai/status");
  const { data: company } = useQuery<{ name: string; isDemo: boolean }>(`/api/companies/${id}`);
  const reset = useMutation<{ confirm: string }, { complete: boolean }>();
  const del = useMutation("DELETE");
  const [confirmName, setConfirmName] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  return (
    <>
      <Group title="AI and execution" hint="Configured by the server operator.">
        <Row label="AI provider" value={<span className={cn("inline-flex items-center gap-1.5", ai?.mode === "live" ? "text-success" : "text-warning")}><span className={cn("dot", ai?.mode === "live" ? "bg-success" : "bg-warning")} />{ai ? (ai.mode === "live" ? "Connected" : "Not configured — planning and runs cannot start") : "…"}</span>} />
        <Row label="Models" value={<code className="mono text-xs">{ai ? `${ai.models.STANDARD} · ${ai.models.REASONING}` : "…"}</code>} />
        <Row label="Execution sandbox" value={<span className="text-sm">{ai ? (ai.sandbox === "docker" ? "Ready (isolated containers)" : "Offline — runs wait until it is available") : "…"}</span>} />
      </Group>
      {company?.isDemo && (
        <Group title="Reset demo workspace" hint="Restores the sample data of this demo workspace only.">
          <Row label="Type RESET" value={<span className="flex gap-2"><input className="input h-7 w-24" value={resetConfirm} onChange={(e) => setResetConfirm(e.target.value)} aria-label="Type RESET" /><button disabled={resetConfirm !== "RESET" || reset.loading} onClick={async () => { await reset.mutate(`/api/companies/${id}/demo/reset`, { confirm: "RESET" }).catch((e) => toast({ title: "Reset failed", description: (e as Error).message, level: "danger" })); setResetConfirm(""); }} className="btn-secondary btn-sm"><RotateCcw className="h-3 w-3" /> Reset</button></span>} />
        </Group>
      )}
      <Group title="Delete workspace" hint="Permanently deletes this workspace, its products, repositories, run history and usage. Cancel any paid plan first.">
        <Row label={`Type "${company?.name ?? ""}"`} value={<span className="flex gap-2"><input className="input h-7 w-48" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} aria-label="Workspace name" /><button disabled={!company || confirmName !== company.name || del.loading} onClick={async () => { try { await del.mutate(`/api/companies/${id}`); setCompanyId(null); router.push("/app"); } catch (e) { toast({ title: "Delete failed", description: (e as Error).message, level: "danger" }); } }} className="btn-danger btn-sm">{del.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} Delete</button></span>} />
      </Group>
    </>
  );
}

function BillingTab({ id, upgrade }: { id: string; upgrade: string | null }) {
  const { data: b, refetch } = useQuery<Billing>(`/api/companies/${id}/billing`, 15000);
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  async function checkout(plan: string) {
    setBusy(plan);
    try {
      const r = await fetchJSON<{ url: string }>(`/api/companies/${id}/billing/checkout`, { method: "POST", body: JSON.stringify({ plan }) });
      window.location.href = r.url;
    } catch (e) {
      toast({ title: "Checkout unavailable", description: (e as Error).message, level: "danger" });
      setBusy(null);
    }
  }
  async function portal() {
    setBusy("portal");
    try {
      const r = await fetchJSON<{ url: string }>(`/api/companies/${id}/billing/portal`, { method: "POST", body: "{}" });
      window.location.href = r.url;
    } catch (e) {
      toast({ title: "Billing portal unavailable", description: (e as Error).message, level: "danger" });
      setBusy(null);
    }
  }
  if (!b) return <div className="skeleton h-40" />;
  const L = b.plan.limits;
  return (
    <div data-testid="billing">
      <Group title="Plan" hint={b.billing.configured ? (b.billing.testMode ? "Payments are in test mode." : undefined) : "Online payments are not configured on this server yet."}>
        <Row label="Current plan" value={<span className="flex items-center gap-2"><span className="font-medium">{b.plan.name}</span><Badge tone={b.status === "active" || b.status === "trialing" ? "success" : b.status === "past_due" ? "warning" : "neutral"}>{b.status.replace("_", " ")}</Badge>{b.cancelAtPeriodEnd && <Badge tone="warning">cancels at period end</Badge>}</span>} />
        {b.currentPeriodEnd && <Row label="Renews" value={new Date(b.currentPeriodEnd).toLocaleDateString()} />}
        {b.status === "past_due" && <Row label="Payment" value={<span className="text-warning">Your last payment failed. Update your payment method to keep paid features.</span>} />}
        {b.canManage && b.hasCustomer && b.billing.configured && <Row label="Billing" value={<button onClick={portal} disabled={!!busy} className="btn-secondary btn-sm"><CreditCard className="h-3 w-3" /> Manage billing <ExternalLink className="h-3 w-3" /></button>} />}
        {!b.canManage && <Row label="Billing" value={<span className="text-xs text-text-muted">Only workspace admins can change the plan.</span>} />}
        {b.canManage && !b.billing.configured && b.billing.missing.length > 0 && <Row label="Server setup" value={<code className="mono text-2xs">{b.billing.missing.join(", ")}</code>} />}
      </Group>
      <Group title="Usage this month" hint={`Since ${new Date(b.usage.since).toLocaleDateString()}. AI usage is estimated from the provider's reported tokens at list prices.`}>
        <Usage label="Engineering runs" used={b.usage.builds} limit={L.buildsPerMonth} />
        <Usage label="AI usage" used={b.usage.aiCostUsd} limit={L.aiBudgetUsdPerMonth} money />
        <Usage label="Sandbox minutes" used={b.usage.sandboxMinutes} limit={L.sandboxMinutesPerMonth} />
        <Usage label="Active products" used={b.usage.products} limit={L.products} />
        <Row label="Tokens" value={<span className="mono text-xs">{Math.round(b.usage.tokensIn).toLocaleString()} in · {Math.round(b.usage.tokensOut).toLocaleString()} out</span>} />
      </Group>
      {b.canManage && (
        <div className="grid gap-3 md:grid-cols-3">
          {PLAN_ORDER.map((pid) => {
            const p = PLANS[pid];
            const current = b.plan.id === pid;
            return (
              <div key={pid} className={cn("rounded-lg border p-4", current ? "border-brand/50" : upgrade === pid ? "border-info/60" : "border-border")}>
                <div className="flex items-center gap-2"><span className="font-medium">{p.name}</span>{current && <Badge tone="success">current</Badge>}</div>
                <div className="mt-1 text-xl font-semibold">{p.priceUsd === null ? "Free" : `$${p.priceUsd}`}<span className="text-xs font-normal text-text-faint">{p.priceUsd ? " / mo" : ""}</span></div>
                <ul className="mt-2 space-y-0.5 text-xs text-text-muted">{p.highlights.map((h) => <li key={h}>{h}</li>)}</ul>
                {!current && pid !== "free" && <button onClick={() => (b.hasCustomer && b.subscribedPlan !== "free" ? portal() : checkout(pid))} disabled={!!busy || !b.billing.configured} className="btn-primary btn-sm mt-3 w-full" data-testid={`upgrade-${pid}`}>{busy === pid ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{b.billing.configured ? `Switch to ${p.name}` : "Not available yet"}</button>}
                {!current && pid === "free" && b.hasCustomer && <button onClick={portal} disabled={!!busy || !b.billing.configured} className="btn-secondary btn-sm mt-3 w-full">Cancel subscription</button>}
              </div>
            );
          })}
        </div>
      )}
      <button onClick={refetch} className="btn-ghost btn-sm mt-3">Refresh</button>
    </div>
  );
}

function Integrations({ id }: { id: string }) {
  const { data: g, refetch } = useQuery<Github>(`/api/companies/${id}/github`);
  const { toast } = useApp();
  const del = useMutation("DELETE");
  if (!g) return <div className="skeleton h-32" />;
  const active = g.installations.filter((i) => i.status === "ACTIVE");
  return (
    <Group title="GitHub" hint="AURA uses a GitHub App with access only to the repositories you select (contents and pull requests). Tokens are short-lived and never stored.">
      {!g.configured ? (
        <Row label="Status" value={<span className="text-sm text-text-muted">GitHub is not configured on this server{g.missing.length ? <> (<code className="mono text-2xs">{g.missing.join(", ")}</code>)</> : null}.</span>} />
      ) : (
        <>
          <Row label="Status" value={active.length ? <span className="text-success">Connected to {active.map((i) => i.account).join(", ")}</span> : <span className="text-text-muted">Not connected</span>} />
          {g.canConnect && g.installUrl && <Row label="Connect" value={<a href={g.installUrl} className="btn-primary btn-sm" data-testid="github-connect"><Github className="h-3.5 w-3.5" /> {active.length ? "Add repositories" : "Connect GitHub"}</a>} />}
          {active.map((i) => (
            <Row key={i.id} label={i.account} value={<button disabled={!g.canConnect} onClick={async () => { const r = await del.mutate(`/api/companies/${id}/github/${i.id}`).catch((e) => { toast({ title: "Disconnect failed", description: (e as Error).message, level: "danger" }); return null; }); if (r) toast({ title: "GitHub disconnected", description: (r as { note: string }).note, level: "info" }); refetch(); }} className="btn-ghost btn-sm">Disconnect</button>} />
          ))}
          <Row label="Next" value={<span className="text-xs text-text-muted">Link a product to a repository from the product&apos;s Repository tab.</span>} />
        </>
      )}
    </Group>
  );
}

function Account() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    setBusy(true);
    setError(null);
    const r = await fetch("/api/auth/account", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) }).then((x) => x.json());
    setBusy(false);
    if (!r.ok) return setError(r.error);
    router.push("/");
  }
  return (
    <Group title="Delete account" hint="Permanently deletes your account and every workspace you own, including their products, repositories, run history and usage. This cannot be undone.">
      <Row label="Confirm password" value={<span className="flex gap-2"><input type="password" className="input h-7 w-48" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" autoComplete="current-password" /><button onClick={remove} disabled={!password || busy} className="btn-danger btn-sm">{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} Delete account</button></span>} />
      {error && <p role="alert" className="px-1 text-xs text-danger">{error}</p>}
    </Group>
  );
}

function Usage({ label, used, limit, money }: { label: string; used: number; limit: number; money?: boolean }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="flex items-center gap-3 border-t border-border-subtle px-4 py-2.5 text-sm first:border-t-0">
      <span className="w-40 text-text-muted">{label}</span>
      <div className="h-1.5 flex-1 rounded-full bg-bg-inset" role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><div className={cn("h-1.5 rounded-full", pct >= 90 ? "bg-danger" : "bg-brand")} style={{ width: `${pct}%` }} /></div>
      <span className="mono w-32 text-right text-xs">{money ? `$${used.toFixed(2)} / $${limit}` : `${Math.round(used)} / ${limit}`}</span>
    </div>
  );
}

function Group({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-5 rounded-lg border border-border">
      <div className="border-b border-border px-4 py-3"><h2 className="text-sm font-medium">{title}</h2>{hint && <p className="mt-0.5 text-xs text-text-muted">{hint}</p>}</div>
      <div>{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border-subtle px-4 py-2.5 text-sm first:border-t-0">
      <span className="text-text-muted">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
