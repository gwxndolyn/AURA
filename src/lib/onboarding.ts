/** Guided product tour: step ids, persisted per user in User.onboarding (JSON). */
export const TOUR_STEPS = [
  { id: "open-demo", label: "Open the demo workspace" },
  { id: "view-missions", label: "Look at the sample missions" },
  { id: "run-example", label: "Run the example mission" },
  { id: "approve-plan", label: "Approve a plan" },
  { id: "inspect-evidence", label: "Inspect test evidence and the diff" },
  { id: "decide-gate", label: "Decide an approval gate" },
  { id: "read-report", label: "Read the completion report" },
] as const;
export type TourStepId = (typeof TOUR_STEPS)[number]["id"];
export const TOUR_STEP_IDS = TOUR_STEPS.map((s) => s.id) as [TourStepId, ...TourStepId[]];

export interface OnboardingState {
  introSeenAt?: string;
  skippedAt?: string;
  completedAt?: string;
  steps: TourStepId[];
}

export function parseOnboarding(raw: string | null | undefined): OnboardingState {
  try {
    const v = JSON.parse(raw || "{}");
    const steps = Array.isArray(v.steps) ? v.steps.filter((s: unknown) => TOUR_STEP_IDS.includes(s as TourStepId)) : [];
    return { introSeenAt: v.introSeenAt, skippedAt: v.skippedAt, completedAt: v.completedAt, steps };
  } catch {
    return { steps: [] };
  }
}
