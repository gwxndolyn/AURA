"use client";

import { labEnabled } from "@/lib/lab";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Plus, Play, Loader2, Building2, Trash2 } from "lucide-react";
import { useQuery, useMutation } from "@/hooks/useApi";
import { EmptyState, Badge, ErrorState } from "@/components/ui/primitives";
import { AuraMark } from "@/components/shell/sidebar";
import { useApp } from "@/lib/store";
import { timeAgo } from "@/lib/utils";

interface CompanyRow {
  id: string;
  name: string;
  mission: string;
  industry: string;
  status: string;
  isDemo: boolean;
  customers: number;
  revenue: number;
  createdAt: string;
}

export default function AppHomePage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <AppHome />
    </Suspense>
  );
}

function AppHome() {
  const router = useRouter();
  const params = useSearchParams();
  const { setCompanyId, toast } = useApp();
  const { data: companies, loading, error, refetch } = useQuery<CompanyRow[]>("/api/companies");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const demoMut = useMutation<unknown, { companyId: string }>();
  const delMut = useMutation<unknown, unknown>("DELETE");
  const [startingDemo, setStartingDemo] = useState(false);

  // Auto-start the (simulation-lab) demo workspace if ?demo=1 and the lab is enabled.
  useEffect(() => {
    if (labEnabled() && params.get("demo") === "1" && !startingDemo) {
      runDemo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runDemo() {
    setStartingDemo(true);
    toast({ title: "Opening your demo workspace", description: "First time only: AURA runs the sample missions to build it (about a minute).", level: "info" });
    try {
      const res = await demoMut.mutate("/api/demo");
      setCompanyId(res.companyId);
      router.push(`/app/${res.companyId}/missions`);
    } catch (e) {
      toast({ title: "Demo failed", description: (e as Error).message, level: "danger" });
      setStartingDemo(false);
    }
  }

  async function remove(id: string) {
    try {
      await delMut.mutate(`/api/companies/${id}`);
      setConfirmDelete(null);
      refetch();
    } catch (e) {
      toast({ title: "Delete failed", description: (e as Error).message, level: "danger" });
    }
  }

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex h-14 max-w-[1080px] items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2">
          <AuraMark />
          <span className="text-sm font-semibold tracking-tight">AURA</span>
        </Link>
        <div className="flex items-center gap-2">
          {labEnabled() && (
            <button onClick={runDemo} disabled={startingDemo} className="btn-secondary">
              {startingDemo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Simulation lab demo
            </button>
          )}
          <Link href="/onboarding" className="btn-primary">
            <Plus className="h-3.5 w-3.5" /> New workspace
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[1080px] px-6 py-8">
        <div className="page-header">
          <div>
            <h1 className="page-title">Workspaces</h1>
            <p className="page-desc">Workspaces you own or belong to. Each has its own products, team, repositories, plan and usage.</p>
          </div>
        </div>

        {error && !companies ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : loading ? (
          <div className="space-y-1">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-14" />)}</div>
        ) : !companies || companies.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No workspaces yet"
            description="Create a workspace and describe your first product. Your AI team drafts the plan for you to review."
            action={
              <div className="flex gap-2">
                <Link href="/onboarding" className="btn-primary"><Plus className="h-3.5 w-3.5" /> Create a workspace</Link>
              </div>
            }
          />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {companies.map((c) => (
              <li key={c.id} className="group relative flex items-center gap-4 px-4 py-3 transition-colors hover:bg-bg-raised">
                <Link href={`/app/${c.id}`} onClick={() => setCompanyId(c.id)} className="flex min-w-0 flex-1 items-center gap-4 after:absolute after:inset-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{c.name}</span>
                      {c.isDemo && <Badge>demo</Badge>}
                    </div>
                    <p className="truncate text-xs text-text-muted">{c.mission}</p>
                  </div>

                  <span className="mono hidden w-16 text-right text-2xs text-text-faint lg:block">{timeAgo(c.createdAt)}</span>
                </Link>
                <div className="relative z-10 flex w-[132px] justify-end">
                  {confirmDelete === c.id ? (
                    <span className="flex items-center gap-1">
                      <button onClick={() => remove(c.id)} className="btn-danger btn-sm">Delete</button>
                      <button onClick={() => setConfirmDelete(null)} className="btn-ghost btn-sm">Cancel</button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmDelete(c.id)} className="icon-btn opacity-0 focus:opacity-100 group-hover:opacity-100" aria-label={`Delete ${c.name}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
