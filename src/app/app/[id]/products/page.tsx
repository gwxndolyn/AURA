"use client";

import Link from "next/link";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { Boxes, Loader2, Sparkles } from "lucide-react";
import { useQuery, fetchJSON } from "@/hooks/useApi";
import { PageHeader, ErrorState, Skeleton, Badge, EmptyState } from "@/components/ui/primitives";
import { useApp } from "@/lib/store";
import { timeAgo } from "@/lib/utils";

interface Row { id: string; title: string; phase: string; phaseLabel: string; status: string; autonomy: string; scopeApproved: boolean; createdAt: string; blocked: number; progress: { verified: number; executable: number; ratio: number | null; nonExecutable: number } }

const EXAMPLE = "Build a web application that helps university students discover hackathons and find teammates based on their skills, interests, and availability.";

export default function ProductsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { toast } = useApp();
  const { data, error, refetch } = useQuery<Row[]>(`/api/companies/${id}/products`);
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const r = await fetchJSON<{ id: string; briefSource: string; fallbackReason?: string }>(`/api/companies/${id}/products`, { method: "POST", body: JSON.stringify({ idea }) });
      toast({ title: "Product created", description: r.briefSource === "model" ? "The PM drafted the brief and backlog." : `Brief and backlog drafted from a deterministic template (${r.fallbackReason ?? "no model"}). Review and edit them.`, level: "success" });
      router.push(`/app/${id}/products/${r.id}`);
    } catch (e) {
      toast({ title: "Product not created", description: (e as Error).message, level: "danger" });
      setBusy(false);
    }
  }

  return (
    <div className="page" data-testid="products">
      <PageHeader title="Products" description="Describe what you want to build. The PM drafts a brief and a small backlog; nothing executes until you approve the scope. Tasks run as real missions with sandbox tests and review, and only verified work is committed." />
      <section className="mb-6 rounded-lg border border-border p-4">
        <label htmlFor="idea" className="metric-label">New product idea</label>
        <textarea id="idea" value={idea} onChange={(e) => setIdea(e.target.value)} rows={3} className="input mt-1 w-full resize-y py-2" placeholder={EXAMPLE} data-testid="idea" />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button onClick={create} disabled={busy || idea.trim().length < 20} className="btn-primary btn-sm" data-testid="create-product">{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Plan this product</button>
          <button onClick={() => setIdea(EXAMPLE)} className="btn-ghost btn-sm">Use the example idea</button>
          <span className="text-2xs text-text-faint">At least 20 characters. The example maps to a small sample codebase so its engineering tasks can really run.</span>
        </div>
      </section>
      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : !data ? <Skeleton className="h-40" /> : data.length === 0 ? (
        <EmptyState icon={Boxes} title="No products yet" description="Create one from an idea above. You'll review the brief, backlog and scope before any agent starts building." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="table text-sm">
            <thead className="bg-bg-raised"><tr><th>Product</th><th>Phase</th><th>Verified (executable)</th><th>Blocked</th><th>Autonomy</th><th>Created</th></tr></thead>
            <tbody>{data.map((p) => (
              <tr key={p.id}>
                <td><Link className="font-medium hover:underline" href={`/app/${id}/products/${p.id}`}>{p.title}</Link>{p.status !== "ACTIVE" && <Badge className="ml-2">{p.status.toLowerCase()}</Badge>}{!p.scopeApproved && <Badge tone="warning" className="ml-2">scope pending</Badge>}</td>
                <td>{p.phaseLabel}</td>
                <td className="mono">{p.progress.executable ? `${p.progress.verified}/${p.progress.executable}` : "—"}{p.progress.nonExecutable ? <span className="text-text-faint"> · {p.progress.nonExecutable} not executable</span> : null}</td>
                <td className="mono">{p.blocked || "—"}</td>
                <td className="text-xs">{p.autonomy.toLowerCase()}</td>
                <td className="text-xs text-text-faint">{timeAgo(p.createdAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
