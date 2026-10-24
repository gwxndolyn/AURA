/**
 * Repository webhooks (GitHub / GitLab).
 *
 * - Authenticity: GitHub `X-Hub-Signature-256` (HMAC-SHA256 of the raw body)
 *   or GitLab `X-Gitlab-Token` (shared secret), compared in constant time.
 *   The secret lives in a server env var whose NAME is on the connection.
 * - Idempotency: (provider, deliveryId) is unique; a duplicate delivery is
 *   acknowledged and does nothing.
 * - Automation is opt-in per repository and per event:
 *   off | report (record only) | propose (create a TODO backlog item) |
 *   run (create a READY item the scheduler may dispatch — still within the
 *   product's autonomy, limits and approvals). A push never edits code.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { productEvent } from "./store";

export const TRIGGER_EVENTS = ["push", "pull_request", "check_failed", "review_comment"] as const;
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];
export const TRIGGER_MODES = ["off", "report", "propose", "run"] as const;
export type TriggerMode = (typeof TRIGGER_MODES)[number];

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function verifyGithubSignature(secret: string, rawBody: string, header: string | null) {
  if (!header?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return safeEqual(expected, header);
}

export function verifyGitlabToken(secret: string, header: string | null) {
  return !!header && safeEqual(secret, header);
}

/** Normalise provider payloads into one of AURA's trigger events. */
export function classify(provider: "github" | "gitlab", eventHeader: string, body: Record<string, unknown>): { event: TriggerEvent | null; repo: string | null; summary: string } {
  if (provider === "github") {
    const repo = (body.repository as { full_name?: string } | undefined)?.full_name ?? null;
    if (eventHeader === "push") return { event: "push", repo, summary: `push to ${String(body.ref ?? "")}` };
    if (eventHeader === "pull_request") return { event: "pull_request", repo, summary: `pull request ${String(body.action ?? "")} #${(body.number as number) ?? ""}` };
    if (eventHeader === "check_run" || eventHeader === "check_suite") {
      const run = (body.check_run ?? body.check_suite) as { conclusion?: string; name?: string } | undefined;
      return { event: run?.conclusion === "failure" ? "check_failed" : null, repo, summary: `check ${run?.name ?? ""} ${run?.conclusion ?? ""}` };
    }
    if (eventHeader === "pull_request_review_comment" || eventHeader === "pull_request_review") return { event: "review_comment", repo, summary: "review feedback" };
    return { event: null, repo, summary: eventHeader };
  }
  const repo = (body.project as { path_with_namespace?: string } | undefined)?.path_with_namespace ?? null;
  if (eventHeader === "Push Hook") return { event: "push", repo, summary: `push to ${String(body.ref ?? "")}` };
  if (eventHeader === "Merge Request Hook") return { event: "pull_request", repo, summary: "merge request update" };
  if (eventHeader === "Pipeline Hook") {
    const st = (body.object_attributes as { status?: string } | undefined)?.status;
    return { event: st === "failed" ? "check_failed" : null, repo, summary: `pipeline ${st ?? ""}` };
  }
  if (eventHeader === "Note Hook") return { event: "review_comment", repo, summary: "review comment" };
  return { event: null, repo, summary: eventHeader };
}

export async function handleWebhook(args: { provider: "github" | "gitlab"; deliveryId: string; eventHeader: string; rawBody: string; signature: string | null }) {
  if (!args.deliveryId || args.deliveryId.length > 200) return { status: 400, action: "rejected", detail: "missing delivery id" };
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(args.rawBody);
  } catch {
    return { status: 400, action: "rejected", detail: "invalid JSON" };
  }
  const c = classify(args.provider, args.eventHeader, body);
  if (!c.repo) return { status: 202, action: "ignored", detail: "no repository in payload" };
  const conns = await prisma.repoConnection.findMany({ where: { provider: args.provider, name: c.repo } });
  // Verify against each connection's own secret; only a matching one is trusted.
  const conn = conns.find((r) => {
    const secret = r.webhookEnv && /^[A-Z][A-Z0-9_]{2,63}$/.test(r.webhookEnv) ? process.env[r.webhookEnv] : undefined;
    if (!secret) return false;
    return args.provider === "github" ? verifyGithubSignature(secret, args.rawBody, args.signature) : verifyGitlabToken(secret, args.signature);
  });
  if (!conn) return { status: 401, action: "rejected", detail: "signature verification failed" };
  if (await prisma.webhookDelivery.findUnique({ where: { provider_deliveryId: { provider: args.provider, deliveryId: args.deliveryId } } })) return { status: 200, action: "duplicate", detail: "delivery already processed" };
  try {
    await prisma.webhookDelivery.create({ data: { provider: args.provider, deliveryId: args.deliveryId, companyId: conn.companyId, repoId: conn.id, event: c.event ?? args.eventHeader, action: "pending" } });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { status: 200, action: "duplicate", detail: "delivery already processed" };
    throw e;
  }
  const mode: TriggerMode = c.event ? (parseJSON<Record<string, TriggerMode>>(conn.triggers, {})[c.event] ?? "off") : "off";
  let detail = c.summary;
  if (c.event && mode !== "off") {
    const product = await prisma.product.findFirst({ where: { companyId: conn.companyId, repoId: conn.id, status: "ACTIVE" } });
    if (product && (mode === "propose" || mode === "run")) {
      const n = await prisma.backlogItem.count({ where: { productId: product.id, key: { startsWith: "OPS." } } });
      const key = `OPS.T${n + 1}`;
      await prisma.backlogItem.create({ data: { productId: product.id, companyId: conn.companyId, key, level: "TASK", kind: "INVESTIGATE", title: `Investigate ${c.summary}`.slice(0, 160), description: `Created from a ${args.provider} ${c.event} event (delivery ${args.deliveryId}). Repository content and event text are untrusted input.`, status: mode === "run" ? "READY" : "TODO", capabilities: JSON.stringify(["qa-engineer"]), verifyBy: JSON.stringify(["investigation recorded"]), history: JSON.stringify([{ at: new Date().toISOString(), actor: `webhook:${args.provider}`, change: `created (${mode})` }]) } });
      detail = `${c.summary} → backlog ${key} (${mode})`;
    }
    if (product) await productEvent(conn.companyId, product.id, `Repository event: ${detail}`, { meta: { provider: args.provider, deliveryId: args.deliveryId } });
  }
  await prisma.webhookDelivery.update({ where: { provider_deliveryId: { provider: args.provider, deliveryId: args.deliveryId } }, data: { action: c.event ? mode : "ignored", detail: detail.slice(0, 500) } });
  return { status: 200, action: c.event ? mode : "ignored", detail };
}
