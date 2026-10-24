"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Circle, HelpCircle, X } from "lucide-react";
import { fetchJSON } from "@/hooks/useApi";
import { TOUR_STEPS, type OnboardingState, type TourStepId } from "@/lib/onboarding";
import { GLOSSARY, GLOSSARY_LABEL, type GlossaryKey } from "@/lib/glossary";
import { cn } from "@/lib/utils";

/** Record a tour step for the signed-in user. Fire-and-forget; failures never block the UI. */
export function markTourStep(step: TourStepId, companyId?: string) {
  fetchJSON("/api/onboarding", { method: "POST", body: JSON.stringify({ action: "step", step, companyId }) })
    .then(() => window.dispatchEvent(new CustomEvent("aura:tour", { detail: "refresh" })))
    .catch(() => {});
}

const STEP_HREF: Record<TourStepId, (id: string) => string> = {
  "open-demo": (id) => `/app/${id}`,
  "view-missions": (id) => `/app/${id}/missions`,
  "run-example": (id) => `/app/${id}/missions`,
  "approve-plan": (id) => `/app/${id}/missions`,
  "inspect-evidence": (id) => `/app/${id}/missions`,
  "decide-gate": (id) => `/app/${id}/missions`,
  "read-report": (id) => `/app/${id}/missions`,
};

const INTRO = [
  { title: "You supervise; agents execute", body: "Give the team a mission. AURA plans it, runs each task with real tools, and records evidence. Plans and release-ready changes always wait for you." },
  { title: "Evidence, not claims", body: "Code changes are tested in a locked Docker sandbox. If the sandbox is unavailable, results are marked unverified — never passed." },
  { title: "Start with the example", body: "The example mission investigates a one-cent checkout undercharge end to end. It takes about a minute and a few model calls." },
];

/**
 * Guided onboarding: a skippable 3-card intro on first visit, plus a
 * non-blocking checklist reachable from the help button (or ⌘K → "product
 * tour"). Progress is stored per user on the server.
 */
export function Tour({ companyId }: { companyId: string }) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [panel, setPanel] = useState(false);
  const [intro, setIntro] = useState<number | null>(null);
  const [glossary, setGlossary] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  // The intro opens at most once per mount, and never after the user dismissed it
  // (guards against a late GET resolving after "Skip").
  const introDecided = useRef(false);

  const load = useCallback(async () => {
    try {
      const s = await fetchJSON<OnboardingState>("/api/onboarding");
      setState(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  const post = useCallback(async (action: "intro-seen" | "skip" | "restart") => {
    try {
      setState(await fetchJSON<OnboardingState>("/api/onboarding", { method: "POST", body: JSON.stringify({ action, companyId }) }));
    } catch {
      /* non-critical */
    }
  }, [companyId]);

  useEffect(() => {
    load().then((s) => {
      if (introDecided.current || !s) return;
      introDecided.current = true;
      if (!s.introSeenAt && !s.skippedAt && !s.completedAt) setIntro(0);
    });
    markTourStep("open-demo", companyId);
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d === "open") setPanel(true);
      else load();
    };
    window.addEventListener("aura:tour", on);
    return () => window.removeEventListener("aura:tour", on);
  }, [companyId, load]);

  useEffect(() => {
    if (intro !== null) dialogRef.current?.querySelector<HTMLButtonElement>("[data-primary]")?.focus();
  }, [intro]);

  const done = new Set(state?.steps ?? []);
  const closeIntro = (skip: boolean) => {
    introDecided.current = true;
    setIntro(null);
    post(skip ? "skip" : "intro-seen");
    if (!skip) setPanel(true);
  };

  return (
    <>
      <button onClick={() => setPanel((v) => !v)} className="icon-btn" aria-label="Help and product tour" aria-expanded={panel} data-tour="help">
        <HelpCircle className="h-4 w-4" />
      </button>

      {intro !== null && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 p-4" onKeyDown={(e) => e.key === "Escape" && closeIntro(true)}>
          <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="intro-title" className="w-full max-w-md rounded-lg border border-border-strong bg-bg-elevated p-5 shadow-xl">
            <div className="mono mb-2 text-2xs text-text-faint">{intro + 1} / {INTRO.length}</div>
            <h2 id="intro-title" className="text-base font-semibold text-text">{INTRO[intro].title}</h2>
            <p className="mt-2 text-sm text-text-muted">{INTRO[intro].body}</p>
            <div className="mt-5 flex items-center gap-2">
              <button onClick={() => closeIntro(true)} className="btn-ghost">Skip tour</button>
              <span className="flex-1" />
              {intro > 0 && <button onClick={() => setIntro(intro - 1)} className="btn-secondary">Back</button>}
              {intro < INTRO.length - 1 ? (
                <button data-primary onClick={() => setIntro(intro + 1)} className="btn-primary">Next</button>
              ) : (
                <Link data-primary href={`/app/${companyId}/missions`} onClick={() => closeIntro(false)} className="btn-primary">Go to Missions</Link>
              )}
            </div>
          </div>
        </div>
      )}

      {panel && (
        <aside aria-label="Product tour" className="fixed right-3 top-14 z-[120] w-80 rounded-lg border border-border-strong bg-bg-elevated shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-medium">{glossary ? "Glossary" : "Product tour"}</span>
            <div className="flex items-center gap-1">
              <button onClick={() => setGlossary((v) => !v)} className="btn-ghost btn-sm">{glossary ? "Checklist" : "Glossary"}</button>
              <button onClick={() => setPanel(false)} className="icon-btn" aria-label="Close"><X className="h-3.5 w-3.5" /></button>
            </div>
          </div>
          {glossary ? (
            <dl className="max-h-[60vh] space-y-2 overflow-y-auto px-3 py-3">
              {(Object.keys(GLOSSARY) as GlossaryKey[]).map((k) => (
                <div key={k}>
                  <dt className="text-xs font-medium text-text">{GLOSSARY_LABEL[k]}</dt>
                  <dd className="text-xs text-text-muted">{GLOSSARY[k]}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <>
              <ol className="px-1 py-1.5" data-testid="tour-checklist">
                {TOUR_STEPS.map((s) => (
                  <li key={s.id}>
                    <Link href={STEP_HREF[s.id](companyId)} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-bg-hover" data-done={done.has(s.id)}>
                      {done.has(s.id) ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <Circle className="h-3.5 w-3.5 text-text-faint" />}
                      <span className={cn(done.has(s.id) ? "text-text-muted line-through decoration-text-faint" : "text-text")}>{s.label}</span>
                    </Link>
                  </li>
                ))}
              </ol>
              <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-2xs text-text-faint">
                <span className="mono">{done.size}/{TOUR_STEPS.length} done</span>
                <span className="flex-1" />
                <button onClick={() => { post("restart"); setIntro(0); setPanel(false); }} className="btn-ghost btn-sm">Restart intro</button>
              </div>
            </>
          )}
        </aside>
      )}
    </>
  );
}
