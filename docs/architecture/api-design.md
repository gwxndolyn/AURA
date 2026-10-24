# API design

All API handlers live under `src/app/api/**/route.ts` (41 routes). They share one
set of conventions enforced by `src/lib/api.ts` and `src/lib/auth/authz.ts`.
**Follow this exactly** — see also [../engineering/api-patterns.md](../engineering/api-patterns.md)
and the `aura-api` skill.

## Response envelope

Every response is one of:

```jsonc
{ "ok": true,  "data": <T> }        // ok(data)      — 200, or ok(x,{status:201})
{ "ok": false, "error": "message" } // err(msg,code) — 4xx/5xx
```

Helpers (`src/lib/api.ts`):

```ts
export function ok<T>(data: T, init?: ResponseInit)      // { ok:true, data }
export function err(message: string, status = 400)       // { ok:false, error }
export async function parseBody<S>(req, schema): z.infer<S>  // 400 bad JSON, 422 Zod
export class ApiError extends Error { status }
export function handler<Ctx>(fn)                          // uniform try/catch wrapper
```

## Canonical route

```ts
import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";       // present on ~every route
type Ctx = { params: Promise<{ id: string }> };  // Next 15: params is a Promise

const CreateSchema = z.object({ title: z.string().min(1).max(120) });

export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;             // always await params
  await requireWorkspaceAccess(id, "MEMBER");  // authorize before anything else
  const body = await parseBody(req, CreateSchema);
  const row = await prisma.task.create({ data: { companyId: id, ...body } });
  return ok(row, { status: 201 });
});
```

Rules that make a route canonical:

- **Never** write your own try/catch — `handler()` maps `AuthError`/`ApiError` to
  `err(...)` and anything else to a logged 500. Throw, don't catch.
- **Authorize first.** `requireWorkspaceAccess(id, role)` before reading params'
  data or the body. `id` (companyId) is the first argument, role second.
- **Role convention:** reads → `VIEWER`; mutations/actions → `MEMBER`; destructive
  (e.g. `DELETE` company) → `OWNER`. Non-company routes use `requireUser()`.
- **Validate with Zod.** Schema is a module-scope const in the route file; enums
  come from `@/lib/types` (e.g. `AUTONOMY_LEVELS`, `PRIORITIES`).
- **Scope every query by `companyId`.** For nested resource IDs use
  `findFirst({ where: { id, companyId } })` — never `findUnique({ id })` alone
  (prevents IDOR). See [../security/tenant-isolation.md](../security/tenant-isolation.md).
- **Emit events** for state changes via `emitEvent({ companyId, type, actor, message, meta })`.
- `maxDuration` is raised on long AI actions (`= 60` on execute/approve etc.,
  `= 120`, `demo` uses `= 300`).

## Exceptions to the wrapper

Three routes are intentionally **not** wrapped in `handler()` and build their own
response:

| Route | Why |
|---|---|
| `api/health/route.ts` | Unauthenticated subsystem probe; returns `ok({ overall, checks, stats })`. |
| `api/ai/status/route.ts` | Unauthenticated status (`mode`, `models`, `budget`, `sandbox`). |
| `api/companies/[id]/stream/route.ts` | SSE — authorizes, then returns a `ReadableStream`. Only route with `export const runtime = "nodejs"`. |

## SSE streaming (the one real-time route)

```ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");  // auth BEFORE streaming
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = (e) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch {} };
      controller.enqueue(encoder.encode(`event: open\ndata: {}\n\n`));
      unsubscribe = subscribe(id, send);
      heartbeat = setInterval(() => { try { controller.enqueue(encoder.encode(`: ping\n\n`)); } catch {} }, 20000);
    },
    cancel() { if (heartbeat) clearInterval(heartbeat); unsubscribe?.(); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  }});
}
```

See [events-and-jobs.md](events-and-jobs.md) for the bus side.

## Route inventory (by area)

- **Auth:** `auth/register` (POST), `auth/login` (POST), `auth/logout` (POST), `auth/me` (GET), `auth/password-reset` (POST).
- **Company lifecycle:** `companies` (GET list, POST create), `companies/[id]` (GET, DELETE), `demo` (POST — open/create the caller's private demo workspace), `companies/[id]/demo/reset` (POST, OWNER, demo only).
- **Work:** `.../plan`, `.../tasks` (GET/POST), `.../tasks/[taskId]` (GET/PATCH/DELETE), `.../tasks/[taskId]/execute` (POST), `.../sprint`, `.../prioritize`, `.../projects`, `.../build`.
- **Agents:** `.../agents` (GET), `.../agents/[agentId]` (GET), `.../agents/[agentId]/availability` (POST), `.../messages`.
- **Deploy / ops:** `.../deploy` (GET/POST), `.../deploy/[deploymentId]/approve` (POST), `.../infrastructure`, `.../incidents`, `.../chaos`.
- **Security:** `.../attack`, `.../findings`, `.../audit`, `.../stress-test`.
- **Insight:** `.../overview`, `.../analytics`, `.../activity`, `.../events`, `.../usage`, `.../decisions`, `.../ceo`, `.../attention`, `.../search`, `.../workspace`, `.../stream`.
- **AI intelligence** (`.../intelligence/*`): `overview`, `scorecards`, `datasets`, `evaluations` (GET/POST), `evaluations/[evaluationId]` (+`/cancel`), `prompts` (GET/POST), `prompts/versions/[versionId]` (GET/PATCH), `experiments`, `promote` (ADMIN), `rollback` (ADMIN), `models` (GET/PUT ADMIN), `failures`, `cost`, `knowledge` (+`/[entryId]` PATCH/DELETE), `skills-audit` (ADMIN). See [intelligence.md](../ai-engineering/intelligence.md).
- **Missions** (`.../missions/*`): list/create, `example`, `[missionId]` detail, `plan`, `advance`, `cancel`, `approvals/[approvalId]` (ADMIN), `report`, `timeline`, `runs/[runId]`, `handoffs/[handoffId]`, and `missions/scorecards`.
- **Development workspace** (`.../devspace/*`): tree, `file` (GET/PUT with expectedRev), `history`, `import`, `missions`, `changes` (+`/[changeId]` GET/POST accept·reject·revert·revise), `checks` (+`/[runId]` GET/DELETE cancel), `activity`. See [development-workspace.md](development-workspace.md).
- **Products** (`.../products/*`): list/create, `[productId]` (GET detail, PATCH autonomy+limits ADMIN), `brief` (PUT revision), `items` (POST add) + `items/[key]` (PATCH status/priority — VERIFIED refused), `tick`, `control` (pause/resume/cancel), `approvals/[approvalId]` (publication/production ADMIN+), `artifacts/[artifactId]` (approve/revise), `release` (GET readiness; POST candidate/publish/deploy), `repo` (GET branches/diff; PUT connect ADMIN), `timeline`. Public `/api/webhooks/{github,gitlab}` (signature-verified, no session). See [../product-lifecycle.md](../product-lifecycle.md).
- **Company twin** (`.../twin/*`): overview, `scenarios`, `config` (GET/POST preview/PUT apply), `runs` (+`/[runId]` save·verify), `compare`, `timeline`, `advise`. See [company-twin.md](company-twin.md).
- **Operations** (`.../ops/*`): `briefing`, `summary` (POST, optional AI), `findings` (GET, filters), `findings/[findingId]` (GET, PATCH lifecycle), `findings/[findingId]/actions` (POST, policy-enforced), `evaluate` (POST), `monitor` (GET; PUT ADMIN; POST heartbeat), `events`, `actions`, `notifications`. See [operations-intelligence.md](operations-intelligence.md). See [missions-and-demo.md](missions-and-demo.md).
- **Global:** `health`, `ai/status`, `onboarding` (GET/POST, per-user tour state).

> If you add a route, update this inventory and the paired skill/workflow doc.
