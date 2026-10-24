/**
 * CSRF defence for cookie-authenticated, state-changing requests. Session
 * cookies are SameSite=Lax (blocks cross-site POSTs from other sites in modern
 * browsers); in addition, middleware rejects unsafe methods whose Origin (or
 * Referer) is present and not this application. Requests without either header
 * (server-to-server, CLI) carry no browser cookie ambiently and are allowed.
 * Webhook endpoints are exempt (they authenticate with signatures, not cookies).
 */
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const EXEMPT = [/^\/api\/billing\/webhook$/, /^\/api\/webhooks\//, /^\/api\/github\/callback$/];

export function allowedOrigins(requestOrigin: string, env: Record<string, string | undefined> = process.env): Set<string> {
  const out = new Set([requestOrigin]);
  for (const v of [env.NEXT_PUBLIC_APP_URL, ...(env.AURA_ALLOWED_ORIGINS ?? "").split(",")]) {
    try {
      if (v?.trim()) out.add(new URL(v.trim()).origin);
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

export function csrfViolation(method: string, pathname: string, headers: { get(n: string): string | null }, requestOrigin: string, env?: Record<string, string | undefined>): string | null {
  if (!UNSAFE.has(method.toUpperCase()) || !pathname.startsWith("/api/") || EXEMPT.some((re) => re.test(pathname))) return null;
  const origin = headers.get("origin");
  const referer = headers.get("referer");
  let source: string | null = null;
  if (origin && origin !== "null") source = origin;
  else if (referer) {
    try {
      source = new URL(referer).origin;
    } catch {
      return "malformed referer";
    }
  } else if (origin === "null") return "opaque origin";
  if (!source) return null;
  return allowedOrigins(requestOrigin, env).has(source) ? null : `cross-origin request from ${source}`;
}
