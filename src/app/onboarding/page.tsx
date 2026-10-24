"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import { AuraMark } from "@/components/shell/sidebar";

const EXAMPLES = [
  "Build me a job scam detection platform where users can submit suspicious job listings, analyse potential scam indicators, and view a dashboard of risk assessments.",
  "A booking app for a small yoga studio: class schedule, sign-ups with a capacity limit, and an admin view of attendees.",
  "An internal tool where my team logs customer feedback, tags it by theme, and sees the top themes this month.",
];

/**
 * First-run onboarding: create a workspace and describe the first product.
 * Both are real API calls; the product manager's planning job starts at once
 * and the user lands on the product, where the plan appears when it's ready.
 */
function Onboarding() {
  const router = useRouter();
  const plan = useSearchParams().get("plan");
  const [workspace, setWorkspace] = useState("");
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = await fetch("/api/companies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: workspace.trim(), mission: idea.trim().slice(0, 300), industry: "Software" }) }).then((r) => r.json());
      if (!c.ok) throw new Error(c.error);
      await fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "skip" }) }).catch(() => null);
      const p = await fetch(`/api/companies/${c.data.id}/products`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idea: idea.trim() }) }).then((r) => r.json());
      if (!p.ok) throw new Error(p.error);
      router.push(plan && plan !== "free" ? `/app/${c.data.id}/settings?tab=billing&upgrade=${plan}` : `/app/${c.data.id}/products/${p.data.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <form onSubmit={submit} className="w-full max-w-xl" data-testid="onboarding">
        <div className="mb-8 flex items-center gap-2"><AuraMark /><span className="text-sm font-semibold tracking-tight">AURA</span></div>
        <h1 className="text-2xl font-semibold">What do you want to build?</h1>
        <p className="mt-1 text-sm text-text-muted">Your product manager will turn this into a plan with user stories and acceptance criteria. You review it before anything is built.</p>
        <label htmlFor="ws" className="label mt-6">Workspace name</label>
        <input id="ws" className="input" placeholder="e.g. Acme" required minLength={2} maxLength={60} value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
        <label htmlFor="idea" className="label mt-4">Describe your product</label>
        <textarea id="idea" className="input h-auto min-h-[120px] resize-y py-2" required minLength={20} maxLength={4000} value={idea} onChange={(e) => setIdea(e.target.value)} placeholder={EXAMPLES[0]} />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXAMPLES.map((x, i) => <button key={i} type="button" onClick={() => setIdea(x)} className="rounded-full border border-border px-2.5 py-1 text-2xs text-text-muted hover:text-text">Example {i + 1}</button>)}
        </div>
        {error && <p role="alert" className="mt-4 rounded-md border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-xs text-danger">{error}</p>}
        <button type="submit" disabled={busy || workspace.trim().length < 2 || idea.trim().length < 20} className="btn-primary mt-6 h-10 w-full" data-testid="onboarding-submit">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Create my plan <ArrowRight className="h-4 w-4" />
        </button>
      </form>
    </main>
  );
}

export default function Page() {
  return <Suspense fallback={<main className="min-h-screen" />}><Onboarding /></Suspense>;
}
