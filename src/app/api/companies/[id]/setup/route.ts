import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { aiMode } from "@/lib/ai/claude";
import { dockerAvailable } from "@/lib/sandbox/docker";
import { billingConfigured } from "@/lib/billing/stripe";
import { githubAppConfigured } from "@/lib/integrations/github/app";
import { emailConfigured } from "@/lib/email/send";
import { secretsConfigured } from "@/lib/security/secrets";
import { effectivePlan } from "@/lib/billing/entitlements";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

type State = "done" | "todo" | "unavailable" | "optional";

/**
 * Setup checklist from backend facts only. "unavailable" = the server operator
 * has not configured it (the customer cannot fix it); "todo" = the customer
 * can act; "done" = confirmed from persisted state or a live check.
 */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "VIEWER");
  const [u, products, firstRun, installs, targets, { plan, status }, docker] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.userId }, select: { emailVerifiedAt: true } }),
    prisma.product.findMany({ where: { companyId: id, status: { not: "CANCELLED" } }, orderBy: { createdAt: "asc" }, select: { id: true, title: true, planningStatus: true, scopeApproved: true } }),
    prisma.build.findFirst({ where: { companyId: id }, orderBy: { createdAt: "asc" }, select: { status: true, productId: true } }),
    prisma.githubInstallation.count({ where: { companyId: id, status: "ACTIVE" } }),
    prisma.deployTarget.count({ where: { companyId: id, status: "CONNECTED" } }),
    effectivePlan(id),
    dockerAvailable(),
  ]);
  const ai = aiMode() === "live";
  const email = emailConfigured().configured;
  const billing = billingConfigured().configured;
  const gh = githubAppConfigured().configured;
  const first = products[0];
  const steps: { id: string; label: string; state: State; detail: string; href?: string }[] = [
    { id: "account", label: "Account created", state: "done", detail: user.email },
    { id: "email", label: "Email address confirmed", state: u?.emailVerifiedAt ? "done" : email ? "todo" : "unavailable", detail: u?.emailVerifiedAt ? "confirmed" : email ? "check your inbox, or resend from Settings → Account" : "email delivery is not configured on this server" },
    { id: "plan", label: "Plan", state: plan.id !== "free" ? "done" : billing ? "optional" : "unavailable", detail: plan.id !== "free" ? `${plan.name} (${status})` : billing ? "Starter (free). Upgrade any time." : "Starter (free). Online payments are not configured on this server.", href: "/settings?tab=billing" },
    { id: "ai", label: "AI model provider", state: ai ? "done" : "unavailable", detail: ai ? "connected" : "not configured by the server operator — planning and runs cannot start" },
    { id: "sandbox", label: "Execution sandbox", state: docker ? "done" : "unavailable", detail: docker ? "Docker available" : "Docker is not available on this server — runs wait until it is" },
    { id: "product", label: "First product", state: first ? "done" : "todo", detail: first ? first.title : "describe what you want to build", href: first ? `/products/${first.id}` : "/products" },
    { id: "plan-review", label: "Plan reviewed and approved", state: !first ? "todo" : first.scopeApproved ? "done" : first.planningStatus === "FAILED" ? "todo" : "todo", detail: !first ? "after the first product" : first.scopeApproved ? "scope approved" : first.planningStatus === "READY" ? "the product manager's plan is waiting for your approval" : first.planningStatus === "FAILED" ? "planning failed — open the product to see why and retry" : "the product manager is drafting the plan", href: first ? `/products/${first.id}` : undefined },
    { id: "first-run", label: "First engineering run", state: firstRun ? "done" : "todo", detail: firstRun ? `status ${firstRun.status.toLowerCase()}` : "starts after the plan is approved", href: firstRun ? `/products/${firstRun.productId}` : undefined },
    { id: "github", label: "GitHub (optional)", state: installs ? "done" : !gh ? "unavailable" : plan.features.githubIntegration ? "optional" : "optional", detail: installs ? `${installs} connection(s)` : !gh ? "the GitHub App is not configured on this server" : plan.features.githubIntegration ? "connect to push branches and open pull requests" : "available on paid plans", href: "/settings?tab=integrations" },
    { id: "deploy", label: "Deployment target (optional)", state: targets ? "done" : plan.features.deploymentRequests ? "optional" : "optional", detail: targets ? `${targets} connected target(s)` : plan.features.deploymentRequests ? "configure from a product's Deploy tab" : "available on paid plans" },
    { id: "secrets", label: "Secret storage", state: secretsConfigured().configured ? "done" : "unavailable", detail: secretsConfigured().configured ? "encrypted store available" : "the server has no encryption key (AURA_SECRETS_KEY); deployment secrets cannot be stored" },
  ];
  return ok({ steps, complete: steps.filter((s) => s.state === "todo").length === 0 });
});
