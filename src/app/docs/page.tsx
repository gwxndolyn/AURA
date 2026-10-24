import Link from "next/link";
import { ProsePage } from "@/components/marketing/site-chrome";

export const metadata = { title: "Documentation — AURA" };

export default function Docs() {
  return (
    <ProsePage title="Documentation">
      <h2 id="start">Getting started</h2>
      <ol className="ml-5 list-decimal space-y-1">
        <li><Link href="/register">Create an account</Link> and a workspace.</li>
        <li>Describe what you want to build. The product manager drafts a brief and a backlog with acceptance criteria.</li>
        <li>Review and approve the scope. Nothing is built before you approve it.</li>
        <li>Press <strong>Run team</strong>. Agents implement tasks in your repository; AURA runs the tests and checks in an isolated sandbox and repairs failures.</li>
        <li>Inspect each verified task: the diff, every command with its output, the acceptance criteria and their evidence.</li>
        <li>Build a release candidate, approve it, and open a pull request on GitHub — or download the source.</li>
      </ol>
      <h2 id="projects">What AURA can build today</h2>
      <p>New projects start from a Node.js web app (HTTP API + HTML/CSS/JS frontend, tested with Node&apos;s built-in test runner). Imported repositories work when they are Node.js projects with a <code>package.json</code> and a <code>test</code> script; AURA also runs <code>lint</code>, <code>typecheck</code>, <code>build</code> and <code>check</code> scripts when they exist. Other languages are not executed yet.</p>
      <h2 id="verification">How verification works</h2>
      <p>After an agent finishes a task, AURA itself installs dependencies (with install scripts disabled), then runs the project&apos;s tests and checks with no network access. Exit codes decide. QA, security and code review read the real output and the diff; a task is verified only when every check passes, each acceptance criterion is backed by evidence and no blocking finding remains. Failures go back to the engineer with the real output, up to your repair limit; after that the task is marked as needing you.</p>
      <h2 id="github">Connecting GitHub</h2>
      <p>Settings → Integrations → Connect GitHub installs the AURA GitHub App on the repositories you choose (Contents and Pull requests read/write). Link a product to a repository to import its code or to publish AURA&apos;s work there. Pull requests are opened only after an admin approves; AURA never merges.</p>
      <h2 id="limits">Plans, usage and limits</h2>
      <p>Each plan includes a number of products, engineering runs, AI budget and sandbox minutes per month (see <Link href="/pricing">pricing</Link>). Usage is shown in Settings → Billing. Runs stop safely when a limit is reached.</p>
      <h2 id="failures">When something fails</h2>
      <p>If the AI provider or the sandbox is unavailable, the run is retried automatically with backoff and then shown as blocked with the reason and a Retry button. Your project and its history are never lost; work in progress stays on the task branch.</p>
      <h2 id="ownership">Code ownership</h2>
      <p>The code is yours. Download it at any time from the product&apos;s Repository tab.</p>
    </ProsePage>
  );
}
