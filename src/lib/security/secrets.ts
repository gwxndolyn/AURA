/**
 * Workspace secrets (e.g. environment variables for a deployed product).
 * Encrypted at rest with AES-256-GCM using AURA_SECRETS_KEY (32 bytes,
 * base64 or hex; held in the server's secret manager, never in the database).
 * The workspace id is bound as additional authenticated data, so a ciphertext
 * copied into another tenant's row fails to decrypt.
 *
 * No API ever returns a value: list() returns names and timestamps only. The
 * only reader is the deployment runner, which decrypts at deploy time, passes
 * the values to the container, registers them for redaction and audits the use.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { audit } from "@/lib/events/emit";
import { registerSecretValue } from "./redact";

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Names reserved for AURA's own configuration: a customer secret may never shadow them. */
export const RESERVED_SECRET = /^(AURA_|ANTHROPIC|DATABASE_URL$|AUTH_SECRET$|STRIPE|GITHUB_APP|RESEND|NEXT_PUBLIC_)/;
const MAX_VALUE = 16 * 1024;

export function secretsConfigured() {
  try {
    key();
    return { configured: true as const };
  } catch (e) {
    return { configured: false as const, reason: (e as Error).message };
  }
}

function key(): Buffer {
  const raw = process.env.AURA_SECRETS_KEY ?? "";
  const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (k.length !== 32) throw new ApiError("Secret storage is not configured on this server (AURA_SECRETS_KEY must be 32 bytes, base64 or hex)", 503);
  return k;
}

export function encrypt(companyId: string, plaintext: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(Buffer.from(companyId));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { ciphertext: ct.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
}

export function decrypt(companyId: string, row: { ciphertext: string; iv: string; tag: string }) {
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(row.iv, "base64"));
  d.setAAD(Buffer.from(companyId));
  d.setAuthTag(Buffer.from(row.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(row.ciphertext, "base64")), d.final()]).toString("utf8");
}

export async function putSecret(companyId: string, name: string, value: string, actor: string) {
  if (!SECRET_NAME.test(name)) throw new ApiError("Secret names are UPPER_SNAKE_CASE (A–Z, 0–9, _), up to 64 characters", 422);
  if (RESERVED_SECRET.test(name)) throw new ApiError(`${name} is reserved for AURA's own configuration`, 422);
  if (!value || value.length > MAX_VALUE) throw new ApiError(`Secret values must be 1–${MAX_VALUE} characters`, 422);
  const enc = encrypt(companyId, value);
  const existing = await prisma.workspaceSecret.findUnique({ where: { companyId_name: { companyId, name } } });
  await prisma.workspaceSecret.upsert({ where: { companyId_name: { companyId, name } }, create: { companyId, name, ...enc, createdBy: actor }, update: { ...enc } });
  await audit(companyId, actor, existing ? "SECRET_UPDATED" : "SECRET_CREATED", name, "value stored encrypted");
  return { name, updated: !!existing };
}

export async function deleteSecret(companyId: string, name: string, actor: string) {
  const r = await prisma.workspaceSecret.deleteMany({ where: { companyId, name } });
  if (!r.count) throw new ApiError("Secret not found", 404);
  await audit(companyId, actor, "SECRET_DELETED", name, "removed");
  return { deleted: true };
}

export async function listSecrets(companyId: string) {
  return prisma.workspaceSecret.findMany({ where: { companyId }, orderBy: { name: "asc" }, select: { name: true, createdBy: true, createdAt: true, updatedAt: true, lastUsedAt: true } });
}

/**
 * Decrypt the named secrets for one consequential use (a deployment). Only
 * names the caller asks for are read — unrelated secrets never leave the store.
 */
export async function decryptSecretsFor(companyId: string, names: string[], purpose: { actor: string; target: string }) {
  if (!names.length) return { values: {} as Record<string, string>, missing: [] as string[] };
  const rows = await prisma.workspaceSecret.findMany({ where: { companyId, name: { in: names } } });
  const values: Record<string, string> = {};
  for (const r of rows) {
    values[r.name] = decrypt(companyId, r);
    registerSecretValue(values[r.name]);
  }
  const missing = names.filter((n) => !(n in values));
  if (rows.length) await prisma.workspaceSecret.updateMany({ where: { companyId, name: { in: rows.map((r) => r.name) } }, data: { lastUsedAt: new Date() } });
  await audit(companyId, purpose.actor, "SECRET_ACCESSED", purpose.target, `${rows.length} secret(s) decrypted: ${rows.map((r) => r.name).join(", ") || "none"}${missing.length ? `; missing ${missing.join(", ")}` : ""}`);
  return { values, missing };
}

export async function secretNamesPresent(companyId: string, names: string[]) {
  const rows = await prisma.workspaceSecret.findMany({ where: { companyId, name: { in: names } }, select: { name: true } });
  return new Set(rows.map((r) => r.name));
}
