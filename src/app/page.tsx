import Link from "next/link";
import dynamic from "next/dynamic";
import { ArrowRight, Check, FileCode2, GitPullRequest, ListChecks, MessageSquareText, PenTool, ShieldCheck, TerminalSquare, Workflow, Layers, Repeat } from "lucide-react";
import { SiteHeader, SiteFooter } from "@/components/marketing/site-chrome";
import { TEAM } from "@/components/marketing/team";
import { PricingCards } from "@/components/marketing/pricing-cards";

const TeamOffice = dynamic(() => import("@/components/marketing/team-office").then((m) => m.TeamOffice), { loading: () => <div className="h-[520px] animate-pulse rounded-xl bg-white/[0.03]" /> });

export const metadata = {
  title: "AURA — Your AI team. From idea to working software.",
  description: "Describe what you want to build. AURA plans it, coordinates AI agents to design and implement it, runs the tests, and helps you ship working software.",
};

const STEPS = [
  { icon: MessageSquareText, title: "Describe", body: "Explain the product in plain language. No templates, no tickets to write." },
  { icon: ListChecks, title: "Plan", body: "A product brief, user stories and acceptance criteria, ordered by dependency. You approve the scope before anything is built." },
  { icon: PenTool, title: "Design", body: "Page and component specs with every loading, empty and error state — reviewed by you, handed to developers." },
  { icon: FileCode2, title: "Build", body: "Engineers write real code and tests in your repository, each task on its own branch." },
  { icon: TerminalSquare, title: "Verify", body: "AURA runs your tests, linting and builds in an isolated sandbox. Failures go back to the engineer with the real output." },
  { icon: GitPullRequest, title: "Ship", body: "Verified work is integrated, re-tested and delivered as a pull request you approve. Your code, always downloadable." },
];

const PROBLEMS = [
  ["Fragmented tools", "A chat for ideas, another for code, another for review — and you carry the context between them."],
  ["You are the coordinator", "Every prompt, every hand-off, every 'now fix this test' is manual work."],
  ["Plans drift from code", "Requirements live in one place, the implementation in another, and nothing checks they match."],
  ["Code that only looks finished", "Generated code compiles until it doesn't. Without running tests, 'done' is a guess."],
];

const CAPS = [
  { icon: ListChecks, title: "Requirements and task management", body: "Briefs with versioned revisions, epics, stories and tasks with dependencies and per-criterion evidence." },
  { icon: FileCode2, title: "AI code generation and editing", body: "Agents read and change files in your repository with tools, scoped by role and audited." },
  { icon: TerminalSquare, title: "Real execution, isolated", body: "Every command runs in a locked-down container with resource limits and no network during tests." },
  { icon: Repeat, title: "Testing, failure analysis and repair", body: "The real output of failing tests goes back to the engineer for a bounded number of repair attempts." },
  { icon: ShieldCheck, title: "Security and code review", body: "Findings must point at code or output. Blocking issues stop the task until they are fixed." },
  { icon: GitPullRequest, title: "Git branches and pull requests", body: "One branch per task, an integrated release branch, and pull requests on GitHub after your approval." },
  { icon: Layers, title: "Design to code hand-off", body: "Approved designs become structured hand-offs developers and QA build and check against." },
  { icon: Workflow, title: "Approvals and audit trail", body: "Scope, releases and publishing need a person. Every agent action and decision is recorded." },
];

const FAQ: [string, string][] = [
  ["How does AURA work?", "You describe a product. A product-manager agent plans it, you approve the scope, and specialised agents design, implement and review it in a git repository. AURA runs the project's tests and checks itself; only work that passes is marked verified. You review everything before it leaves AURA."],
  ["Which repositories and languages are supported?", "New projects start as a Node.js web application. You can also connect a GitHub repository; Node.js projects with a package.json test script can be built and verified. Other languages are not executed yet."],
  ["What do I need to set up?", "Nothing to start: create an account and describe your product. To publish pull requests, connect GitHub from Settings (available on paid plans)."],
  ["How is code execution secured?", "Each command runs in a fresh, unprivileged container with dropped capabilities, a read-only system, CPU/memory/time limits and no network during tests. Dependency installation runs separately with install scripts disabled. No credentials or other customers' files are ever available to your code."],
  ["What happens when an agent fails?", "The real failure output goes back to the engineer for a limited number of repair attempts. If it still fails, the task is marked as needing you, with the evidence and the work in progress on its branch. If the AI provider or sandbox is unavailable, the run is retried and then paused with a retry button — your project is never lost."],
  ["Who owns the code?", "You do. Download the source at any time or keep it in your own GitHub repository."],
  ["Does AURA deploy to production?", "Not automatically. AURA delivers verified pull requests; production deployment always requires your explicit approval and your own deployment setup."],
  ["How does billing work?", "Start on the free plan. Paid plans are monthly subscriptions through Stripe with clear limits on products, engineering runs, AI usage and sandbox minutes. Upgrade, downgrade or cancel any time from Settings."],
];

function Preview() {
  // A labelled illustration of the product interface (static artwork, not live data).
  const tasks = [
    { key: "E1.S1.T1", title: "Listing submission API", state: "verified" },
    { key: "E1.S1.T2", title: "Scam indicator scoring", state: "verified" },
    { key: "E1.S2.T1", title: "Risk dashboard", state: "running" },
    { key: "E1.S2.T2", title: "Report export", state: "ready" },
  ];
  return (
    <figure className="overflow-hidden rounded-xl border border-white/10 bg-[#0f0f12] shadow-2xl shadow-black/40">
      <div className="flex items-center gap-1.5 border-b border-white/5 px-4 py-2.5"><span className="h-2.5 w-2.5 rounded-full bg-white/10" /><span className="h-2.5 w-2.5 rounded-full bg-white/10" /><span className="h-2.5 w-2.5 rounded-full bg-white/10" /><span className="ml-3 text-2xs text-text-faint">Job scam detection platform · Implementation</span></div>
      <div className="grid gap-0 md:grid-cols-[1.1fr_1fr]">
        <div className="border-b border-white/5 p-4 md:border-b-0 md:border-r">
          <div className="text-2xs uppercase tracking-wider text-text-faint">Backlog</div>
          <ul className="mt-2 space-y-1.5">
            {tasks.map((t) => (
              <li key={t.key} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-xs">
                <span className={`h-1.5 w-1.5 rounded-full ${t.state === "verified" ? "bg-success" : t.state === "running" ? "bg-brand" : "bg-white/30"}`} />
                <span className="mono text-text-faint">{t.key}</span><span className="truncate">{t.title}</span><span className="ml-auto text-2xs text-text-faint">{t.state}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="p-4">
          <div className="text-2xs uppercase tracking-wider text-text-faint">Verification · E1.S1.T2</div>
          <pre className="mono mt-2 overflow-hidden rounded-md bg-black/40 p-3 text-[11px] leading-5 text-text-muted">{`$ npm test --silent
✔ flags upfront-payment requests
✔ scores urgency language
✔ rejects empty listings with 400
# pass 3  fail 0           exit 0

$ npm run lint             exit 0`}</pre>
          <div className="mt-3 space-y-1 text-xs">
            {["Listings asking for payment are high risk", "Empty listings are rejected"].map((c) => <div key={c} className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-success" />{c}</div>)}
          </div>
        </div>
      </div>
      <figcaption className="border-t border-white/5 px-4 py-2 text-2xs text-text-faint">Illustration of the AURA project view.</figcaption>
    </figure>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0b0b0d] text-text">
      <SiteHeader />
      <main>
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(800px_400px_at_50%_-10%,rgba(197,240,74,0.10),transparent_70%)]" />
          <div className="relative mx-auto max-w-6xl px-5 pb-16 pt-16 md:pt-24">
            <h1 className="max-w-3xl text-4xl font-semibold leading-[1.05] tracking-tight md:text-6xl">Your AI team.<br /><span className="text-text-muted">From idea to working software.</span></h1>
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-text-muted md:text-lg">Describe what you want to build. AURA turns your idea into a structured development plan, coordinates AI agents to design and implement your application, runs tests, and helps you ship working software.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/register" className="btn-primary h-10 px-5 text-sm" data-testid="hero-start">Start building <ArrowRight className="h-4 w-4" /></Link>
              <Link href="#how" className="btn-secondary h-10 px-5 text-sm">See how it works</Link>
            </div>
            <div className="mt-14"><Preview /></div>
          </div>
        </section>

        {/* Problem */}
        <section className="border-t border-white/5">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <h2 className="max-w-2xl text-2xl font-semibold tracking-tight md:text-3xl">AI can write code. Getting working software out of it is still your job.</h2>
            <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {PROBLEMS.map(([t, b]) => <div key={t}><div className="font-medium">{t}</div><p className="mt-1.5 text-sm leading-relaxed text-text-muted">{b}</p></div>)}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="scroll-mt-16 border-t border-white/5">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">How AURA works</h2>
            <p className="mt-3 max-w-2xl text-text-muted">One workflow, from a sentence to a reviewed pull request.</p>
            <ol className="mt-10 grid gap-px overflow-hidden rounded-xl border border-white/5 bg-white/5 sm:grid-cols-2 lg:grid-cols-3">
              {STEPS.map((s, i) => (
                <li key={s.title} className="bg-[#0b0b0d] p-6">
                  <div className="flex items-center gap-3"><span className="mono text-2xs text-text-faint">0{i + 1}</span><s.icon className="h-4 w-4 text-brand" /><span className="font-medium">{s.title}</span></div>
                  <p className="mt-3 text-sm leading-relaxed text-text-muted">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Team */}
        <section id="team" className="scroll-mt-16 border-t border-white/5">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 lg:grid-cols-[1fr_1.4fr] lg:items-center">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">One coordinated AI team</h2>
              <p className="mt-3 text-text-muted">Each role works from the same project state: the brief, the backlog, the design, the code and the test results. Work moves between them through explicit dependencies and hand-offs, and every failed check comes back to the person — or agent — who can fix it.</p>
              <ul className="mt-6 space-y-3">
                {TEAM.slice(0, 6).map((t) => <li key={t.key} className="text-sm"><span className="font-medium">{t.role}.</span> <span className="text-text-muted">{t.does}</span></li>)}
              </ul>
            </div>
            <div className="overflow-hidden rounded-xl border border-white/10"><TeamOffice /></div>
          </div>
        </section>

        {/* Capabilities */}
        <section className="border-t border-white/5">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">Built for real projects</h2>
            <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {CAPS.map((c) => <div key={c.title}><c.icon className="h-4 w-4 text-brand" /><div className="mt-3 font-medium">{c.title}</div><p className="mt-1.5 text-sm leading-relaxed text-text-muted">{c.body}</p></div>)}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="scroll-mt-16 border-t border-white/5">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">Simple pricing</h2>
            <p className="mt-3 text-text-muted">Start free. Upgrade when you need more projects, GitHub pull requests or a team.</p>
            <PricingCards />
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-16 border-t border-white/5">
          <div className="mx-auto max-w-3xl px-5 py-20">
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">Questions</h2>
            <div className="mt-8 divide-y divide-white/5 border-y border-white/5">
              {FAQ.map(([q, a]) => (
                <details key={q} className="group py-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between font-medium">{q}<span className="text-text-faint transition group-open:rotate-45">+</span></summary>
                  <p className="mt-3 text-sm leading-relaxed text-text-muted">{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="border-t border-white/5">
          <div className="mx-auto max-w-6xl px-5 py-24 text-center">
            <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Tell AURA what you want to build.</h2>
            <p className="mx-auto mt-3 max-w-xl text-text-muted">Your first plan is a few minutes away.</p>
            <Link href="/register" className="btn-primary mt-8 h-11 px-6 text-sm">Start building <ArrowRight className="h-4 w-4" /></Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
