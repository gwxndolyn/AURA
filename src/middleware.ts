import { NextRequest, NextResponse } from "next/server";
import { verifySessionTokenEdge } from "@/lib/auth/edge";
import { csrfViolation } from "@/lib/auth/csrf";

const SESSION_COOKIE = "aura_session";

/**
 * Edge middleware: first line of defense. Blocks unauthenticated access to
 * company-scoped API routes and the /app UI. Fine-grained PER-WORKSPACE
 * authorization still happens in each route via requireWorkspaceAccess (defense
 * in depth) — middleware only proves "is a valid session present".
 *
 * Public: landing, auth pages, auth API, health, and Next internals/static
 * assets. /api/demo and /api/onboarding are outside the matcher but call
 * requireUser() themselves.
 */
const PUBLIC_API = [/^\/api\/auth\//, /^\/api\/health$/];
// Every other /api route outside /api/companies authenticates itself (requireUser / signatures).
const PUBLIC_PAGES = ["/", "/login", "/register", "/forgot-password", "/reset-password", "/verify-email", "/invite", "/health", "/pricing", "/docs", "/terms", "/privacy", "/security"];

/**
 * Simulation-lab surfaces (legacy company simulator). Disabled unless
 * AURA_SIMULATION_LAB=1: pages redirect to the workspace home, APIs return 404.
 */
const LAB_API = /^\/api\/companies\/[^/]+\/(sim|attack|chaos|deploy|stress-test|ceo|build|plan|sprint|prioritize|decisions|twin|infrastructure|incidents|analytics|tasks|projects)(\/|$)/;
const LAB_PAGE = /^\/app\/([^/]+)\/(lab|twin|projects|decisions|deployments|infrastructure|incidents|cyber-range|analytics|company)(\/|$)/;

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const csrf = csrfViolation(req.method, pathname, req.headers, req.nextUrl.origin);
  if (csrf) return NextResponse.json({ ok: false, error: "Cross-site request blocked" }, { status: 403 });
  if (process.env.AURA_SIMULATION_LAB !== "1") {
    if (LAB_API.test(pathname)) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    const m = pathname.match(LAB_PAGE);
    if (m) {
      const url = req.nextUrl.clone();
      url.pathname = `/app/${m[1]}`;
      return NextResponse.redirect(url);
    }
  }

  const isProtectedApi =
    pathname.startsWith("/api/companies") && !PUBLIC_API.some((re) => re.test(pathname));
  const isProtectedPage = pathname.startsWith("/app");

  if (!isProtectedApi && !isProtectedPage) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionTokenEdge(token) : null;

  if (!session) {
    if (isProtectedApi) {
      return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // /api/:path* so the CSRF origin check covers every state-changing API call (auth, onboarding, admin…).
  matcher: ["/app/:path*", "/api/:path*"],
};
