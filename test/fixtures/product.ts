/**
 * TEST FIXTURES ONLY. Deterministic briefs, backlogs and designs used by unit
 * tests to exercise schemas and lifecycle rules without a model. Never
 * imported by application code (enforced by src/lib/factory/no-fixtures.test.ts).
 */
import type { Brief, BacklogDraft } from "@/lib/factory/brief";
import type { DesignSpec } from "@/lib/factory/design";

const words = (s: string) => s.toLowerCase();

/**
 * Deterministic template brief. Uses only the idea text plus conservative,
 * explicitly-labelled defaults (every default is an editable assumption).
 */
export function templateBrief(idea: string): Brief {
  const t = idea.trim().replace(/\s+/g, " ");
  const lower = words(t);
  const audience = /students?/.test(lower) ? "University students" : /developers?/.test(lower) ? "Developers" : /teams?/.test(lower) ? "Small teams" : "Primary users";
  const matching = /team ?mates?|match|partner/.test(lower);
  const discovery = /discover|find|search|browse|hackathon|event/.test(lower);
  const named = t.match(/(?:build|create|make)\s+(?:a|an)\s+(.{6,60}?)(?:\s+that|\s+which|\s+to|,|\.|$)/i)?.[1] ?? t.slice(0, 60);
  // A generic noun ("web application") says nothing; name it after what it helps users do.
  const purpose = t.match(/helps?\s+.{2,60}?\s+(?:to\s+)?((?:discover|find|track|manage|plan|share|learn|book|organi[sz]e|build|connect)\b[^,.]{3,40}?)(?:\s+and\s|,|\.|$)/i)?.[1];
  const generic = /^(simple |small |tiny )?(web |mobile )?(app|application|website|platform|tool|service)$/i.test(named.trim());
  const title = (generic && purpose ? `${purpose}${matching ? " & find teammates" : ""}` : named).replace(/^\w/, (c) => c.toUpperCase());
  const fr: Brief["functional"] = [];
  const add = (text: string) => fr.push({ id: `FR-${fr.length + 1}`, text });
  add("Users can create an account and a profile");
  if (discovery) add(/hackathon/.test(lower) ? "Users can browse and filter upcoming hackathons" : "Users can browse and filter the main catalogue");
  if (matching) add("Users are only matched with teammates who share at least one availability slot, ranked by shared skills and interests");
  if (matching) add("Users can send and accept team invitations");
  if (fr.length < 3) add("Users can complete the core task described in the idea");
  return {
    title: title.slice(0, 90),
    problem: `From the idea: "${t.slice(0, 600)}"`,
    personas: [{ name: audience, needs: [discovery ? "Find relevant opportunities quickly" : "Complete the core task quickly", ...(matching ? ["Find compatible teammates"] : [])] }],
    outcomes: [matching ? "A user finds at least one compatible teammate in their first session" : "A user completes the core task in their first session"],
    functional: fr,
    nonFunctional: [
      { id: "NFR-1", text: "Core pages are usable on mobile and desktop and meet WCAG 2.1 AA contrast" },
      { id: "NFR-2", text: "Profile data is only visible to signed-in users; contact details are never exposed in match results" },
    ],
    mvp: fr.slice(0, 3).map((f) => f.text),
    outOfScope: ["Payments", "Native mobile apps", "Organiser admin tools"],
    journeys: [{ name: matching ? "Find a teammate" : "First use", steps: ["Sign up", "Complete profile", ...(discovery ? ["Browse and filter"] : []), ...(matching ? ["Review ranked matches", "Send an invitation"] : ["Complete the core task"])] }],
    acceptance: [
      ...(matching ? [{ id: "AC-1", text: "Candidates with no shared availability are never returned as matches (automated test)", measurable: true }] : []),
      { id: `AC-${matching ? 2 : 1}`, text: "Matching/ranking logic has automated tests that pass in the sandbox", measurable: true },
      { id: `AC-${matching ? 3 : 2}`, text: "Incomplete profiles never crash matching or listing", measurable: true },
    ],
    assumptions: [
      { id: "A-1", text: "Web application first; responsive layout instead of native apps", editable: true },
      { id: "A-2", text: "Availability is modelled as weekly time slots (e.g. sat-am)", editable: true },
      { id: "A-3", text: "Email/password sign-up is sufficient for the MVP", editable: true },
    ],
    risks: ["Sparse profiles reduce match quality", "Privacy expectations around contact details"],
    questions: [{ text: "Should students outside a single university be able to match?", material: true, default: "Yes — open to any signed-in student; can be restricted later." }],
    milestones: [{ id: "M1", name: "MVP", goal: fr.slice(0, 3).map((f) => f.text).join("; ").slice(0, 300) }],
  };
}

/** Initial backlog derived from the brief. Task keys are stable and dependency-ordered. */
export function templateBacklog(brief: Brief): BacklogDraft {
  const matchFr = brief.functional.find((f) => /availability slot/.test(f.text));
  const stories: BacklogDraft["epics"][number]["stories"] = [];
  if (matchFr) {
    stories.push({
      key: "E1.S1",
      title: `As a student I only see teammates I can actually meet with (${matchFr.id})`,
      acceptance: ["Candidates without shared availability are excluded", "Incomplete profiles never crash matching"],
      milestone: "M1",
      tasks: [
        { key: "E1.S1.T1", title: "Design the match results page", description: "Page and component spec for the ranked match list: states (loading, empty, error), responsive layout, accessibility.", kind: "DESIGN", acceptance: ["Empty, loading and error states specified", "Mobile and desktop layouts specified"], dependsOn: [], effort: 2, risk: "LOW", files: [], requirements: ["NFR-1"] },
        { key: "E1.S1.T2", title: "Matching rules and data contract", description: "Define the profile shape (skills, interests, availability slots) and the ranking contract for matchTeammates().", kind: "ARCHITECTURE", acceptance: ["Profile fields and optionality documented", "Ranking order defined"], dependsOn: [], effort: 1, risk: "LOW", files: ["src/match/match.js"], requirements: [] },
        { key: "E1.S1.T3", title: "Exclude candidates without shared availability", description: "Change matchTeammates() so candidates that share no availability slot are never returned, and incomplete profiles are tolerated. Existing tests must keep passing.", kind: "BACKEND", acceptance: ["'excludes candidates with no shared availability' passes in the sandbox", "No other test regresses"], dependsOn: ["E1.S1.T2"], effort: 3, risk: "MEDIUM", files: ["src/match/match.js"], requirements: brief.acceptance.filter((a) => /availability|crash/.test(a.text)).map((a) => a.id) },
      ],
    });
  }
  stories.push({
    key: `E1.S${stories.length + 1}`,
    title: "As a user I can create a profile",
    acceptance: ["Profile with skills, interests and availability can be saved"],
    milestone: "M1",
    tasks: [
      { key: `E1.S${stories.length + 1}.T1`, title: "Profile form and validation", description: "Profile form with validation for skills, interests and availability.", kind: "FRONTEND", acceptance: ["Invalid input shows field-level errors"], dependsOn: matchFr ? ["E1.S1.T1"] : [], effort: 3, risk: "LOW", files: [], requirements: ["FR-1"] },
    ],
  });
  return { epics: [{ key: "E1", title: brief.milestones[0]?.name ? `${brief.milestones[0].name}: ${brief.title}`.slice(0, 120) : brief.title, stories }] };
}


export function templateDesign(brief: Brief, conventions: string[]): DesignSpec {
  const matching = brief.functional.some((f) => /match|teammate/i.test(f.text));
  return {
    summary: `Design for "${brief.title}": ${matching ? "a ranked match list with filters, profile completion and invitations" : "the core MVP flow"}. Mobile-first, keyboard accessible, every async view specifies loading/empty/error states.`,
    conventions: conventions.length ? conventions : ["No existing UI conventions detected; minimal neutral system proposed below"],
    tokens: { colors: { bg: "#0f1115", surface: "#171a21", text: "#e8eaf0", muted: "#9aa3b2", accent: "#7c9cff", danger: "#ef6b6b" }, type: { body: "Inter 15/22", heading: "Inter 600 22/28", mono: "JetBrains Mono 13/18" }, spacing: [4, 8, 12, 16, 24, 32] },
    flows: brief.journeys.map((j) => ({ name: j.name, steps: j.steps.slice(0, 8) })),
    pages: [
      ...(matching
        ? [{
            id: "matches",
            title: "Your matches",
            purpose: "Show teammates the student can actually meet with, ranked by shared skills and interests.",
            blocks: [
              { kind: "header" as const, label: "Your matches", note: "count of results" },
              { kind: "filters" as const, label: "Skills · Interests · Availability" },
              { kind: "list" as const, label: "Ranked match cards", note: "name, shared skills, shared slots — never contact details" },
              { kind: "cta" as const, label: "Invite to team" },
            ],
            states: { loading: "Skeleton cards (3) with reduced motion respected", empty: "No one shares your availability yet — add more slots or widen filters", error: "Couldn't load matches. Retry keeps your filters.", success: "Invitation sent toast with undo" },
            responsive: { mobile: "Single column cards, filters in a bottom sheet", desktop: "Filters sidebar (240px) + 2-column card grid" },
          }]
        : []),
      {
        id: "profile",
        title: "Profile",
        purpose: "Capture what matching needs: skills, interests, weekly availability.",
        blocks: [
          { kind: "header", label: "Your profile" },
          { kind: "form", label: "Skills, interests, availability slots", note: "field-level validation messages" },
          { kind: "cta", label: "Save profile" },
        ],
        states: { loading: "Form disabled with spinner on save", empty: "Prompt to add at least one skill and slot", error: "Inline field errors; nothing is lost", success: "Saved, with link to matches" },
        responsive: { mobile: "Stacked fields, sticky save bar", desktop: "Two-column form" },
      },
    ],
    components: [
      ...(matching ? [{ name: "MatchCard", props: ["name", "sharedSkills", "sharedSlots", "score"], states: ["default", "invited", "focus"], a11y: "Card is an article with a heading; invite is a real button with an accessible name" }] : []),
      { name: "SlotPicker", props: ["value", "onChange"], states: ["empty", "selected", "error"], a11y: "Checkbox grid with row/column headers; operable by keyboard" },
    ],
    accessibility: ["WCAG 2.1 AA contrast for text and controls", "All actions keyboard operable with visible focus", "Status changes announced via aria-live", "Respect prefers-reduced-motion"],
  };
}

