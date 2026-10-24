/**
 * Edge-runtime-safe session verification using Web Crypto (no Node `crypto`).
 * Mirrors the HMAC-SHA256 scheme in session.ts so middleware can validate the
 * token signature + expiry without importing Node-only modules.
 */

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function edgeSecret(): string | null {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) return process.env.NODE_ENV === "production" ? null : "aura-dev-insecure-secret-change-me";
  return s;
}

export async function verifySessionTokenEdge(token: string): Promise<{ userId: string; email: string } | null> {
  try {
    const [data, sig] = token.split(".");
    if (!data || !sig) return null;
    const secret = edgeSecret();
    if (!secret) return null; // production without AUTH_SECRET: never accept tokens signed with the dev fallback
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    const expected = bytesToB64url(mac);
    if (expected !== sig) return null;
    const body = JSON.parse(new TextDecoder().decode(b64urlToBytes(data)));
    if (!body.userId || typeof body.exp !== "number") return null;
    if (Math.floor(Date.now() / 1000) > body.exp) return null;
    return { userId: body.userId, email: body.email ?? "" };
  } catch {
    return null;
  }
}
