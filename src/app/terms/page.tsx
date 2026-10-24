import { ProsePage } from "@/components/marketing/site-chrome";

export const metadata = { title: "Terms of service — AURA" };
const OPERATOR = process.env.NEXT_PUBLIC_COMPANY_NAME || "the operator of this AURA service";

export default function Terms() {
  return (
    <ProsePage title="Terms of service" updated="2026-10-21">
      <p>These terms govern your use of AURA, provided by {OPERATOR}. By creating an account you agree to them. If you use AURA on behalf of an organisation, you confirm you can bind it.</p>
      <h2>The service</h2>
      <p>AURA coordinates AI agents that plan, write, test and review software in repositories you create or connect. Agents can make mistakes. You are responsible for reviewing changes before you merge, publish or deploy them; AURA never merges or deploys without your explicit approval.</p>
      <h2>Your content and code</h2>
      <p>You keep all rights to your ideas, requirements, repositories and the code AURA produces for you. You grant us only the permissions needed to operate the service for you (store, process and execute your project in isolated environments). We do not use your private code to train models.</p>
      <h2>Acceptable use</h2>
      <ul><li>Don&apos;t use AURA to build malware, attack systems you don&apos;t own, or violate the law.</li><li>Don&apos;t attempt to break out of the execution sandbox or access other customers&apos; data.</li><li>Respect the usage limits of your plan.</li></ul>
      <h2>Third-party services</h2>
      <p>AURA uses an AI model provider, a payment processor and, when you connect it, GitHub. Their terms also apply to your use of those integrations.</p>
      <h2>Plans and billing</h2>
      <p>Paid plans renew monthly until cancelled. You can cancel at any time from Settings → Billing; access continues until the end of the paid period. Usage limits are listed on the pricing page.</p>
      <h2>No warranty and liability</h2>
      <p>AURA is provided &quot;as is&quot;. To the extent permitted by law, we are not liable for indirect or consequential damages, and our total liability is limited to the amount you paid in the twelve months before the claim.</p>
      <h2>Termination</h2>
      <p>You can delete your account at any time (Settings → Account). We may suspend accounts that violate these terms.</p>
      <h2>Changes</h2>
      <p>We will notify you of material changes before they take effect.</p>
    </ProsePage>
  );
}
