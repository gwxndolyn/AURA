import { ProsePage } from "@/components/marketing/site-chrome";

export const metadata = { title: "Security — AURA" };

export default function Security() {
  return (
    <ProsePage title="How AURA keeps your code and workspace safe">
      <p>AURA runs AI-generated code, so the platform treats every repository file, command output and model response as untrusted.</p>
      <h2>Isolated execution</h2>
      <ul>
        <li>Every command runs in a fresh container as an unprivileged user, with all Linux capabilities dropped, no privilege escalation, a read-only root filesystem, memory/CPU/process limits and a hard time limit.</li>
        <li>Tests, builds and checks run with <strong>no network access</strong>. Dependency installation is a separate step with registry access and package install scripts disabled.</li>
        <li>No AURA credentials, environment variables or other customers&apos; files are ever mounted into a container.</li>
        <li>Agents can only run an allowlist of project commands; shell operators are refused.</li>
      </ul>
      <h2>Agents are authorised in code</h2>
      <p>Each role has a fixed tool allowlist and write scope enforced by the server — a model asking for more access gets nothing. Every tool call is recorded in the audit log.</p>
      <h2>Verification you can inspect</h2>
      <p>A task is marked verified only when the platform itself re-runs the project&apos;s tests and checks and they pass, and reviewers&apos; blocking findings are resolved. You can open every command and its real output.</p>
      <h2>Human approval for consequential actions</h2>
      <p>Opening pull requests and production deployments always require an explicit approval from a workspace admin. AURA never merges to your default branch.</p>
      <h2>Accounts and tenancy</h2>
      <p>Sessions are signed, http-only cookies. Workspace access is checked server-side on every request, with role-based permissions. GitHub access uses a GitHub App with repository-level permissions and short-lived tokens.</p>
      <h2>Reporting a vulnerability</h2>
      <p>{process.env.NEXT_PUBLIC_SECURITY_EMAIL ? <>Email <a href={`mailto:${process.env.NEXT_PUBLIC_SECURITY_EMAIL}`}>{process.env.NEXT_PUBLIC_SECURITY_EMAIL}</a>.</> : "Contact the operator of this AURA service."} We do not claim compliance certifications that have not been obtained.</p>
    </ProsePage>
  );
}
