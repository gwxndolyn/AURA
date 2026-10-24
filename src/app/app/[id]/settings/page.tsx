"use client";

import { Suspense, use, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Trash2, Loader2, RotateCcw, Github, CreditCard, ExternalLink, Download, KeyRound, UserPlus, X } from "lucide-react";
import { useQuery, useMutation, fetchJSON } from "@/hooks/useApi";
import { useApp } from "@/lib/store";
import { PageHeader, Badge } from "@/components/ui/primitives";
import { cn, timeAgo } from "@/lib/utils";

interface AiStatus { mode: string; models: Record<string, string>; sandbox: string }
interface Billing {
  plan: { id: string; name: string; limits: { products: number; buildsPerMonth: number; aiBudgetUsdPerMonth: number; sandboxMinutesPerMonth: number; concurrentBuilds: number; seats: number; deploysPerMonth: number; retentionDays: number } };
  subscribedPlan: string; interval: string; status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; hasCustomer: boolean; hasSubscription: boolean;
  usage: { since: string; builds: number; deploys: number; aiCostUsd: number; tokensIn: number; tokensOut: number; sandboxMinutes: number; products: number; seats: number; reserved: { builds: number; concurrentBuilds: number }; costBasis: string };
  spendingCapUsd: number | null;
  catalogue: { id: string; name: string; priceUsd: number | null; priceUsdYear: number | null; highlights: string[]; annualAvailable: boolean }[];
  billing: { configured: boolean; testMode: boolean; live: boolean; missing: string[] };
  invoices: { id: string; number: string; status: string; currency: string; amountDue: number; amountPaid: number; hostedUrl: string; createdAt: string }[];
  canManage: boolean;
}
interface Github { configured: boolean; missing: string[]; installUrl: string | null; canConnect: boolean; installations: { id: string; account: string; status: string; connectedBy: string; createdAt: string }[] }

const TABS = ["general", "members", "billing", "usage", "integrations", "secrets", "security", "account"] as const;
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
    if (c === "success") toast({ title: "Checkout submitted", description: "Your plan changes only once the payment provider confirms the payment — usually within seconds. This page refreshes automatically.", level: "info" });
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
      <PageHeader title="Settings" description="Workspace, members, plan and usage, integrations, secrets, security and your account." />
      <div className="tabs mb-5" role="tablist">{TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} data-active={tab === t} onClick={() => go(t)} className="tab capitalize">{t}</button>)}</div>
      {tab === "general" && <General id={id} />}
      {tab === "members" && <MembersTab id={id} />}
      {tab === "billing" && <BillingTab id={id} upgrade={search.get("upgrade")} checkout={search.get("checkout")} />}
      {tab === "usage" && <UsageTab id={id} />}
      {tab === "integrations" && <Integrations id={id} />}
      {tab === "secrets" && <SecretsTab id={id} />}
      {tab === "security" && <SecurityTab id={id} />}
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
        <Row label={`Type "${company?.name ?? ""}"`} value={<span className="flex gap-2"><input className="input h-7 w-48" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} aria-label="Workspace name" /><button disabled={!company || confirmName !== company.name || del.loading} onClick={async () => { try { await fetchJSON(`/api/companies/${id}`, { method: "DELETE", body: JSON.stringify({ confirm: confirmName }) }); setCompanyId(null); router.push("/app"); } catch (e) { toast({ title: "Delete failed", description: (e as Error).message, level: "danger" }); } }} className="btn-danger btn-sm">{del.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} Delete</button></span>} />
      </Group>
    </>
  );
}

function BillingTab({ id, upgrade, checkout }: { id: string; upgrade: string | null; checkout: string | null }) {
  const { data: b, refetch } = useQuery<Billing>(`/api/companies/${id}/billing`, checkout === "success" ? 4000 : 15000);
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [interval, setIntervalChoice] = useState<"month" | "year">("month");
  useEffect(() => {
    // After a checkout redirect, ask the server to read the subscription from the provider (never trusting the redirect itself).
    if (checkout === "success") void fetchJSON(`/api/companies/${id}/billing/sync`, { method: "POST", body: "{}" }).then(refetch).catch(() => null);
  }, [checkout, id, refetch]);
  async function choose(plan: string) {
    setBusy(plan);
    try {
      const r = await fetchJSON<{ changed: boolean; url: string | null; note: string | null }>(`/api/companies/${id}/billing/checkout`, { method: "POST", body: JSON.stringify({ plan, interval }) });
      if (r.url) return void (window.location.href = r.url);
      toast({ title: "Plan change requested", description: r.note ?? undefined, level: "info" });
      setTimeout(refetch, 3000);
    } catch (e) {
      toast({ title: "Plan change not possible", description: (e as Error).message, level: "danger" });
    }
    setBusy(null);
  }
  async function post(path: string, body: unknown, label: string) {
    setBusy(label);
    try {
      const r = await fetchJSON<{ url?: string; note?: string }>(`/api/companies/${id}/billing/${path}`, { method: "POST", body: JSON.stringify(body) });
      if (r.url) return void (window.location.href = r.url);
      if (r.note) toast({ title: "Requested", description: r.note, level: "info" });
      setTimeout(refetch, 2500);
    } catch (e) {
      toast({ title: "Billing action failed", description: (e as Error).message, level: "danger" });
    }
    setBusy(null);
  }
  if (!b) return <div className="skeleton h-40" />;
  const L = b.plan.limits;
  const money = (cents: number, cur: string) => `${(cents / 100).toFixed(2)} ${cur.toUpperCase()}`;
  return (
    <div data-testid="billing">
      <Group title="Plan" hint={b.billing.configured ? (b.billing.testMode ? "Payments are in test mode — no real charges." : undefined) : "Online payments are not configured on this server yet."}>
        <Row label="Current plan" value={<span className="flex items-center gap-2"><span className="font-medium">{b.plan.name}</span>{b.hasSubscription && <span className="text-xs text-text-muted">{b.interval === "year" ? "annual" : "monthly"}</span>}<Badge tone={b.status === "active" || b.status === "trialing" ? "success" : b.status === "past_due" ? "warning" : "neutral"}>{b.status.replace("_", " ")}</Badge>{b.cancelAtPeriodEnd && <Badge tone="warning">cancels at period end</Badge>}</span>} />
        {b.currentPeriodEnd && <Row label={b.cancelAtPeriodEnd ? "Ends" : "Renews"} value={new Date(b.currentPeriodEnd).toLocaleDateString()} />}
        {b.status === "past_due" && <Row label="Payment" value={<span className="text-warning">Your last payment failed. Update your payment method to keep paid features.</span>} />}
        {b.canManage && b.hasCustomer && b.billing.configured && <Row label="Payment method and invoices" value={<button onClick={() => post("portal", {}, "portal")} disabled={!!busy} className="btn-secondary btn-sm"><CreditCard className="h-3 w-3" /> Manage in Stripe <ExternalLink className="h-3 w-3" /></button>} />}
        {b.canManage && b.hasSubscription && b.billing.configured && <Row label="Subscription" value={b.cancelAtPeriodEnd ? <button onClick={() => post("cancel", { resume: true }, "resume")} disabled={!!busy} className="btn-secondary btn-sm">Keep my subscription</button> : <button onClick={() => post("cancel", {}, "cancel")} disabled={!!busy} className="btn-ghost btn-sm" data-testid="cancel-subscription">Cancel at period end</button>} />}
        {!b.canManage && <Row label="Billing" value={<span className="text-xs text-text-muted">Only workspace admins can change the plan.</span>} />}
        {b.canManage && !b.billing.configured && b.billing.missing.length > 0 && <Row label="Server setup" value={<code className="mono text-2xs">{b.billing.missing.join(", ")}</code>} />}
      </Group>
      {b.canManage && (
        <>
          <div className="mb-2 flex items-center gap-2 text-xs"><span className="text-text-muted">Billing period</span>{(["month", "year"] as const).map((i) => <button key={i} onClick={() => setIntervalChoice(i)} data-active={interval === i} className={cn("rounded-md border px-2 py-0.5", interval === i ? "border-brand/50 text-text" : "border-border text-text-muted")}>{i === "month" ? "Monthly" : "Annual"}</button>)}</div>
          <div className="mb-5 grid gap-3 md:grid-cols-3">
            {b.catalogue.map((p) => {
              const current = b.plan.id === p.id && (p.id === "free" || b.interval === interval);
              const yearly = interval === "year";
              const price = p.priceUsd === null ? "Free" : yearly ? (p.priceUsdYear !== null ? `$${p.priceUsdYear}` : "—") : `$${p.priceUsd}`;
              const unavailable = p.id !== "free" && yearly && !p.annualAvailable;
              return (
                <div key={p.id} className={cn("rounded-lg border p-4", current ? "border-brand/50" : upgrade === p.id ? "border-info/60" : "border-border")}>
                  <div className="flex items-center gap-2"><span className="font-medium">{p.name}</span>{current && <Badge tone="success">current</Badge>}</div>
                  <div className="mt-1 text-xl font-semibold">{price}<span className="text-xs font-normal text-text-faint">{p.priceUsd ? (yearly ? " / yr" : " / mo") : ""}</span></div>
                  <ul className="mt-2 space-y-0.5 text-xs text-text-muted">{p.highlights.map((h) => <li key={h}>{h}</li>)}</ul>
                  {!current && p.id !== "free" && <button onClick={() => choose(p.id)} disabled={!!busy || !b.billing.configured || unavailable} className="btn-primary btn-sm mt-3 w-full" data-testid={`upgrade-${p.id}`}>{busy === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{!b.billing.configured ? "Not available yet" : unavailable ? "Monthly only" : b.hasSubscription ? `Switch to ${p.name}` : `Choose ${p.name}`}</button>}
                  {!current && p.id === "free" && b.hasSubscription && !b.cancelAtPeriodEnd && <button onClick={() => post("cancel", {}, "cancel")} disabled={!!busy || !b.billing.configured} className="btn-secondary btn-sm mt-3 w-full">Cancel subscription</button>}
                </div>
              );
            })}
          </div>
          <p className="-mt-3 mb-5 text-2xs text-text-faint">Switching plans is prorated by Stripe. Your access changes when Stripe confirms the change, not when you click.</p>
        </>
      )}
      {b.canManage && (
        <Group title="Invoices" hint="As reported by the payment provider.">
          {b.invoices.length === 0 ? <Row label="None yet" value={<span className="text-xs text-text-muted">Invoices appear after the first payment.</span>} /> : b.invoices.map((i) => (
            <Row key={i.id} label={`${i.number || i.id} · ${new Date(i.createdAt).toLocaleDateString()}`} value={<span className="flex items-center gap-2"><span className="mono text-xs">{money(i.amountPaid || i.amountDue, i.currency)}</span><Badge tone={i.status === "paid" ? "success" : i.status === "open" ? "warning" : "neutral"}>{i.status}</Badge>{i.hostedUrl && <a href={i.hostedUrl} target="_blank" rel="noreferrer noopener" className="btn-ghost btn-sm">View <ExternalLink className="h-3 w-3" /></a>}</span>} />
          ))}
        </Group>
      )}
      <button onClick={refetch} className="btn-ghost btn-sm mt-1">Refresh</button>
    </div>
  );
}

interface MembersData { ownerId: string; me: { userId: string; role: string }; seats: { used: number; limit: number }; members: { userId: string; role: string; email: string; name: string; joinedAt: string; emailVerified: boolean }[]; invitations: { id: string; email: string; role: string; expiresAt: string }[] }

function MembersTab({ id }: { id: string }) {
  const { data: m, refetch } = useQuery<MembersData>(`/api/companies/${id}/members`);
  const { toast } = useApp();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("MEMBER");
  const [busy, setBusy] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  if (!m) return <div className="skeleton h-40" />;
  const manager = ["OWNER", "ADMIN"].includes(m.me.role);
  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast({ title: ok, level: "success" });
      refetch();
    } catch (e) {
      toast({ title: "Not done", description: (e as Error).message, level: "danger" });
    }
  }
  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await fetchJSON<{ emailSent: boolean; devLink?: string }>(`/api/companies/${id}/members/invitations`, { method: "POST", body: JSON.stringify({ email, role }) });
      toast({ title: r.emailSent ? "Invitation sent" : "Invitation created", description: r.emailSent ? undefined : "Email delivery is not configured on this server, so no email was sent. Share the link with them yourself.", level: r.emailSent ? "success" : "warning" });
      setDevLink(r.devLink ?? null);
      setEmail("");
      refetch();
    } catch (err) {
      toast({ title: "Invitation not sent", description: (err as Error).message, level: "danger" });
    }
    setBusy(false);
  }
  return (
    <div data-testid="members">
      <Group title="Members" hint={`${m.seats.used} of ${m.seats.limit} seats in use (members + pending invitations). Roles: owner (everything), admin (people, billing, integrations, secrets, production), member (build and change code, preview deploys), viewer (read only).`}>
        {m.members.map((x) => (
          <Row key={x.userId} label={<span className="flex flex-col text-left"><span className="text-text">{x.name}{x.userId === m.me.userId ? " (you)" : ""}</span><span className="text-2xs">{x.email}{!x.emailVerified ? " · unverified" : ""}</span></span> as unknown as string} value={
            <span className="flex items-center gap-2">
              {manager && x.userId !== m.ownerId && x.userId !== m.me.userId ? (
                <select aria-label={`Role of ${x.email}`} className="input h-7 w-28" value={x.role} onChange={(e) => act(() => fetchJSON(`/api/companies/${id}/members/${x.userId}`, { method: "PATCH", body: JSON.stringify({ role: e.target.value }) }), "Role updated")}>
                  {(m.me.role === "OWNER" ? ["ADMIN", "MEMBER", "VIEWER"] : ["MEMBER", "VIEWER"]).concat(m.me.role !== "OWNER" && x.role === "ADMIN" ? ["ADMIN"] : []).map((r) => <option key={r} value={r}>{r.toLowerCase()}</option>)}
                </select>
              ) : <Badge tone={x.role === "OWNER" ? "success" : "neutral"}>{x.role.toLowerCase()}</Badge>}
              {m.me.role === "OWNER" && x.userId !== m.me.userId && <button className="btn-ghost btn-sm" onClick={() => confirm(`Make ${x.email} the owner? You will become an admin.`) && act(() => fetchJSON(`/api/companies/${id}/members/transfer`, { method: "POST", body: JSON.stringify({ userId: x.userId }) }), "Ownership transferred")}>Make owner</button>}
              {x.userId !== m.ownerId && (manager || x.userId === m.me.userId) && <button aria-label={x.userId === m.me.userId ? "Leave workspace" : `Remove ${x.email}`} className="btn-ghost btn-sm" onClick={() => confirm(x.userId === m.me.userId ? "Leave this workspace?" : `Remove ${x.email}?`) && act(() => fetchJSON(`/api/companies/${id}/members/${x.userId}`, { method: "DELETE" }), x.userId === m.me.userId ? "You left the workspace" : "Member removed")}><X className="h-3 w-3" /></button>}
            </span>
          } />
        ))}
      </Group>
      {manager && (
        <Group title="Invite" hint="Invitations expire after 7 days and can only be accepted by the invited email address.">
          <form onSubmit={invite} className="flex flex-wrap items-center gap-2 px-4 py-3">
            <input type="email" required aria-label="Email to invite" placeholder="name@company.com" className="input h-8 flex-1" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select aria-label="Role" className="input h-8 w-28" value={role} onChange={(e) => setRole(e.target.value)}>{(m.me.role === "OWNER" ? ["ADMIN", "MEMBER", "VIEWER"] : ["MEMBER", "VIEWER"]).map((r) => <option key={r} value={r}>{r.toLowerCase()}</option>)}</select>
            <button disabled={busy || m.seats.used >= m.seats.limit} className="btn-primary btn-sm" data-testid="invite-submit">{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserPlus className="h-3 w-3" />} Invite</button>
          </form>
          {m.seats.used >= m.seats.limit && <p className="px-4 pb-3 text-xs text-warning">All seats are in use. Upgrade in Billing or remove a member to invite someone.</p>}
          {devLink && <p className="px-4 pb-3 text-2xs">Invitation link (share it yourself): <code className="mono break-all">{devLink}</code></p>}
          {m.invitations.map((i) => <Row key={i.id} label={`${i.email} · ${i.role.toLowerCase()}`} value={<span className="flex items-center gap-2 text-xs text-text-muted">expires {new Date(i.expiresAt).toLocaleDateString()}<button className="btn-ghost btn-sm" onClick={() => act(() => fetchJSON(`/api/companies/${id}/members/invitations/${i.id}`, { method: "DELETE" }), "Invitation revoked")}>Revoke</button></span>} />)}
        </Group>
      )}
    </div>
  );
}

function UsageTab({ id }: { id: string }) {
  const { data: b, refetch } = useQuery<Billing>(`/api/companies/${id}/billing`, 15000);
  const { toast } = useApp();
  const [cap, setCap] = useState<string>("");
  if (!b) return <div className="skeleton h-40" />;
  const L = b.plan.limits;
  const effectiveAi = Math.min(L.aiBudgetUsdPerMonth, b.spendingCapUsd ?? Infinity);
  async function saveCap() {
    try {
      await fetchJSON(`/api/companies/${id}`, { method: "PATCH", body: JSON.stringify({ monthlyBudgetUsd: Number(cap) }) });
      toast({ title: "Spending cap saved", level: "success" });
      setCap("");
      refetch();
    } catch (e) {
      toast({ title: "Not saved", description: (e as Error).message, level: "danger" });
    }
  }
  return (
    <div data-testid="usage">
      <Group title="Usage this month" hint={`Since ${new Date(b.usage.since).toLocaleDateString()}. AI usage is ${b.usage.costBasis} — an estimate, not an invoice.`}>
        <Usage label="Engineering runs" used={b.usage.builds} limit={L.buildsPerMonth} />
        <Usage label="AI usage (est.)" used={b.usage.aiCostUsd} limit={effectiveAi} money />
        <Usage label="Sandbox minutes" used={b.usage.sandboxMinutes} limit={L.sandboxMinutesPerMonth} />
        <Usage label="Deployments" used={b.usage.deploys} limit={L.deploysPerMonth} />
        <Usage label="Active products" used={b.usage.products} limit={L.products} />
        <Usage label="Seats" used={b.usage.seats} limit={L.seats} />
        <Row label="Running now" value={<span className="mono text-xs">{b.usage.reserved.concurrentBuilds} of {L.concurrentBuilds} parallel run(s)</span>} />
        <Row label="Tokens" value={<span className="mono text-xs">{Math.round(b.usage.tokensIn).toLocaleString()} in · {Math.round(b.usage.tokensOut).toLocaleString()} out (provider-reported)</span>} />
      </Group>
      <Group title="Spending cap" hint={`Stop AI work for the rest of the month once estimated spend reaches this amount. Your plan includes up to $${L.aiBudgetUsdPerMonth}; the lower of the two applies. You are warned at 80%.`}>
        <Row label="Current cap" value={<span className="mono text-xs">{b.spendingCapUsd !== null ? `$${b.spendingCapUsd.toFixed(2)}` : "none"} → effective ${effectiveAi.toFixed(2)}</span>} />
        {b.canManage && <Row label="Set cap (USD)" value={<span className="flex gap-2"><input type="number" min={0} step="1" className="input h-7 w-24" value={cap} onChange={(e) => setCap(e.target.value)} aria-label="Monthly spending cap in USD" /><button disabled={cap === "" || Number(cap) < 0} onClick={saveCap} className="btn-secondary btn-sm">Save</button></span>} />}
      </Group>
    </div>
  );
}

function SecretsTab({ id }: { id: string }) {
  const { data, refetch } = useQuery<{ configured: boolean; reason: string | null; secrets: { name: string; createdBy: string; updatedAt: string; lastUsedAt: string | null }[] }>(`/api/companies/${id}/secrets`);
  const { toast } = useApp();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  if (!data) return <div className="skeleton h-32" />;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await fetchJSON(`/api/companies/${id}/secrets`, { method: "PUT", body: JSON.stringify({ name, value }) });
      toast({ title: `${name} saved`, description: "The value is encrypted and can't be viewed again.", level: "success" });
      setName("");
      setValue("");
      refetch();
    } catch (err) {
      toast({ title: "Not saved", description: (err as Error).message, level: "danger" });
    }
  }
  return (
    <div data-testid="secrets">
      <Group title="Deployment secrets" hint="Environment variables injected into your deployed apps (list their names on a product's Deploy tab). Values are encrypted (AES-256-GCM), are never shown again, never sent to AI models, and every use is recorded in the audit log.">
        {!data.configured ? <Row label="Status" value={<span className="text-xs text-warning">{data.reason}</span>} /> : (
          <>
            {data.secrets.length === 0 && <Row label="None yet" value={<span className="text-xs text-text-muted">Add one below.</span>} />}
            {data.secrets.map((x) => <Row key={x.name} label={<span className="mono text-xs text-text">{x.name}</span> as unknown as string} value={<span className="flex items-center gap-2 text-2xs text-text-muted">updated {timeAgo(x.updatedAt)}{x.lastUsedAt ? ` · used ${timeAgo(x.lastUsedAt)}` : " · never used"}<button aria-label={`Delete ${x.name}`} className="btn-ghost btn-sm" onClick={async () => { if (!confirm(`Delete ${x.name}?`)) return; try { await fetchJSON(`/api/companies/${id}/secrets/${encodeURIComponent(x.name)}`, { method: "DELETE" }); refetch(); } catch (e) { toast({ title: "Not deleted", description: (e as Error).message, level: "danger" }); } }}><Trash2 className="h-3 w-3" /></button></span>} />)}
            <form onSubmit={save} className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-4 py-3">
              <input required pattern="[A-Z][A-Z0-9_]*" aria-label="Secret name" placeholder="NAME_LIKE_THIS" className="input mono h-8 w-48" value={name} onChange={(e) => setName(e.target.value.toUpperCase())} />
              <input required type="password" autoComplete="off" aria-label="Secret value" placeholder="value" className="input h-8 flex-1" value={value} onChange={(e) => setValue(e.target.value)} />
              <button className="btn-primary btn-sm"><KeyRound className="h-3 w-3" /> Save</button>
            </form>
          </>
        )}
      </Group>
    </div>
  );
}

interface AuditEntry { id: string; actor: string; action: string; target: string; result: string; category: string; outcome: string; createdAt: string }

function SecurityTab({ id }: { id: string }) {
  const [category, setCategory] = useState("");
  const { data, error } = useQuery<{ entries: AuditEntry[]; categories: string[] }>(`/api/companies/${id}/audit-log${category ? `?category=${category}` : ""}`);
  const { data: company, refetch } = useQuery<{ retentionDays: number }>(`/api/companies/${id}`);
  const { toast } = useApp();
  const [days, setDays] = useState("");
  return (
    <div data-testid="security">
      <Group title="Data" hint="Export everything AURA stores for this workspace, or choose how long run output is kept.">
        <Row label="Export" value={<a href={`/api/companies/${id}/export`} className="btn-secondary btn-sm" data-testid="export"><Download className="h-3 w-3" /> Download JSON export</a>} />
        <Row label="Run output retention" value={<span className="flex items-center gap-2"><span className="mono text-xs">{company?.retentionDays ?? "…"} days</span><input type="number" min={1} className="input h-7 w-20" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Retention days" /><button disabled={!days} className="btn-secondary btn-sm" onClick={async () => { try { await fetchJSON(`/api/companies/${id}`, { method: "PATCH", body: JSON.stringify({ retentionDays: Number(days) }) }); setDays(""); refetch(); } catch (e) { toast({ title: "Not saved", description: (e as Error).message, level: "danger" }); } }}>Save</button></span>} />
        <Row label="What is kept" value={<span className="max-w-md text-left text-2xs text-text-muted">After the retention period, command output, deployment logs and tool payloads are erased. Run records, costs and the audit log are kept until the workspace is deleted. See the <a className="underline" href="/security">security page</a> for what is retained by third parties.</span>} />
      </Group>
      <Group title="Audit log" hint="Security, membership, billing, integration, secret, execution, deployment and data events. Visible to admins; entries can't be edited or deleted.">
        <div className="flex flex-wrap gap-1.5 px-4 py-2">{["", ...(data?.categories ?? [])].map((c) => <button key={c || "all"} onClick={() => setCategory(c)} data-active={category === c} className={cn("rounded-full border px-2 py-0.5 text-2xs capitalize", category === c ? "border-brand/50 text-text" : "border-border text-text-muted")}>{c || "all"}</button>)}</div>
        {error && <Row label="Unavailable" value={<span className="text-xs text-text-muted">{error}</span>} />}
        {data?.entries.length === 0 && <Row label="Nothing yet" value="" />}
        {data?.entries.map((e) => (
          <div key={e.id} className="grid grid-cols-[120px_1fr] gap-3 border-t border-border-subtle px-4 py-2 text-xs">
            <span className="text-text-faint">{timeAgo(e.createdAt)}</span>
            <span><span className={cn("mono", e.outcome === "denied" ? "text-danger" : "text-text")}>{e.action}</span> <span className="text-text-muted">by {e.actor} · {e.target}</span>{e.result && <span className="block text-2xs text-text-faint">{e.result}</span>}</span>
          </div>
        ))}
      </Group>
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
    <>
    <AccountSecurity />
    <Group title="Delete account" hint="Permanently deletes your account and every workspace you own (transfer shared workspaces first), including their products, repositories, run history and usage. Backups and copies held by GitHub, Stripe and the email provider are not removed by AURA — see the security page. This cannot be undone.">
      <Row label="Confirm password" value={<span className="flex gap-2"><input type="password" className="input h-7 w-48" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" autoComplete="current-password" /><button onClick={remove} disabled={!password || busy} className="btn-danger btn-sm">{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} Delete account</button></span>} />
      {error && <p role="alert" className="px-1 text-xs text-danger">{error}</p>}
    </Group>
    </>
  );
}

function AccountSecurity() {
  const { data: me } = useQuery<{ user: { email: string; emailVerified?: boolean } | null }>("/api/auth/me");
  const { toast } = useApp();
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  async function run(fn: () => Promise<unknown>, ok: string, desc?: string) {
    try {
      await fn();
      toast({ title: ok, description: desc, level: "success" });
    } catch (e) {
      toast({ title: "Not done", description: (e as Error).message, level: "danger" });
    }
  }
  return (
    <Group title="Sign-in and security" hint="Changing your password signs you out on every other device.">
      <Row label="Email" value={<span className="flex items-center gap-2 text-sm">{me?.user?.email ?? "…"}{me?.user && (me.user.emailVerified ? <Badge tone="success">confirmed</Badge> : <button className="btn-ghost btn-sm" onClick={() => run(() => fetchJSON("/api/auth/verify-email", { method: "POST", body: JSON.stringify({ resend: true }) }), "Verification email requested", "If email delivery is configured, a link is on its way.")}>Send confirmation link</button>)}</span>} />
      <Row label="Change password" value={<span className="flex gap-2"><input type="password" autoComplete="current-password" aria-label="Current password" placeholder="current" className="input h-7 w-32" value={current} onChange={(e) => setCurrent(e.target.value)} /><input type="password" autoComplete="new-password" minLength={10} aria-label="New password" placeholder="new (10+ chars)" className="input h-7 w-36" value={next} onChange={(e) => setNext(e.target.value)} /><button disabled={!current || next.length < 10} className="btn-secondary btn-sm" onClick={() => run(async () => { await fetchJSON("/api/auth/password", { method: "POST", body: JSON.stringify({ current, next }) }); setCurrent(""); setNext(""); }, "Password changed", "Other sessions were signed out.")}>Change</button></span>} />
      <Row label="Sessions" value={<span className="flex gap-2"><button className="btn-secondary btn-sm" onClick={() => run(() => fetchJSON("/api/auth/sessions", { method: "DELETE" }), "Signed out on other devices")}>Sign out other devices</button><button className="btn-ghost btn-sm" onClick={async () => { await fetchJSON("/api/auth/logout", { method: "POST", body: JSON.stringify({ everywhere: true }) }).catch(() => null); router.push("/login"); }}>Sign out everywhere</button></span>} />
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
