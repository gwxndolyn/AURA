import { ProsePage } from "@/components/marketing/site-chrome";

export const metadata = { title: "Privacy policy — AURA" };

export default function Privacy() {
  const support = process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
  return (
    <ProsePage title="Privacy policy" updated="2026-10-21">
      <p>This policy explains what AURA stores and why. It describes how the software works; the operator of your AURA service is the data controller.</p>
      <h2>What we store</h2>
      <ul>
        <li><strong>Account:</strong> name, email, a salted scrypt password hash, workspace memberships.</li>
        <li><strong>Projects:</strong> your product descriptions, plans, backlog, design and architecture documents, and the git repositories AURA creates or imports for you.</li>
        <li><strong>Execution records:</strong> commands run in the sandbox with their exit codes and output, agent runs with token usage and estimated cost, approvals and an audit log.</li>
        <li><strong>Billing:</strong> plan and subscription status. Card details are handled by the payment processor and never reach AURA.</li>
        <li><strong>Integrations:</strong> the GitHub App installation id and repository name you link. Access tokens are short-lived and are not stored.</li>
      </ul>
      <h2>How it is used</h2>
      <p>To run the service: planning and code generation send the relevant project context to the configured AI model provider; code runs in isolated containers; we email you for account recovery and billing. We do not sell personal data and do not use your private code to train models.</p>
      <h2>Isolation</h2>
      <p>Every request is checked server-side against your workspace membership. Generated code runs without access to AURA&apos;s credentials or other customers&apos; files.</p>
      <h2>Retention and deletion</h2>
      <p>You can delete a product, or your whole account, from the application. Deleting your account removes the workspaces you own, their projects, repositories, execution records and usage history. Billing records required by law are kept by the payment processor.</p>
      <h2>Contact</h2>
      <p>{support ? <>Questions or requests: <a href={`mailto:${support}`}>{support}</a>.</> : "Contact the operator of this AURA service."}</p>
    </ProsePage>
  );
}
