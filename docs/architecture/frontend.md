# Frontend

Next.js App Router, React 18, Tailwind (dark-first), Framer Motion, Recharts,
React Flow. State is Zustand + native fetch with a small polling/SSE hook layer —
**no TanStack Query** (`src/components/providers.tsx` is a thin pass-through).

## Server vs client components

- **Server components:** `src/app/layout.tsx` (root; `html className="dark"`,
  globals + reactflow CSS, `<Providers>`, `<Toaster>`), `src/app/page.tsx` (landing).
- **Everything under `src/app/app/[id]/*` is `"use client"`** — the app shell is
  interactive and polls/streams. So are `onboarding`, `app` (picker), `health`.

## Data access from the client

Use the hooks in `src/hooks/useApi.ts` — never hand-roll fetch:

```ts
import { useQuery, useMutation, fetchJSON } from "@/hooks/useApi";

const { data, loading, error, refetch } = useQuery<Overview>(`/api/companies/${id}/overview`, 6000); // polls every 6s
const { mutate, loading } = useMutation("POST");
await mutate(`/api/companies/${id}/tasks/${taskId}/execute`);
```

- `useQuery(url | null, pollMs?)` — pass `null` to skip; returns `{data, loading, error, refetch}`. It unwraps the `{ ok, data }` envelope for you.
- `useMutation(method)` — `{ mutate(url, body?), loading, error }`.
- Realtime: `useLiveEvents(companyId, max=60)` opens an `EventSource` to
  `/api/companies/[id]/stream` and returns `{ events (newest first), version, connected }`.
  Bump a `useQuery` off `version` to refetch when relevant events arrive.

## Global state (`src/lib/store.ts`)

Zustand `useApp`: `companyId`/`setCompanyId` (persisted to `localStorage["aura.companyId"]`),
`toasts`/`toast()` (auto-dismiss 5s)/`dismiss()`, `commandOpen`/`setCommandOpen`
(⌘K palette).

## Component inventory

| Folder | Components (purpose) |
|---|---|
| `shell/` | `nav.ts` (single source of nav groups), `sidebar` (grouped nav, workspace switcher, user/sign-out; `MobileSidebar` drawer below `md`), `topbar` (breadcrumb, search, AI mode/sandbox/spend readouts, `sim-controls`), `command-palette` (⌘K: keyboard-navigable search + commands), `sim-controls` (client-side sim loop — **serverless-safe, no server timers**) |
| `dashboard/` | `quick-actions` (one primary Build action + Operations menu), `attention-panel` ("Needs you" rows with inline actions), `activity-feed` (event log: filter by severity, expandable rows; history backfilled from `/events`), `ceo-dialog` |
| `cyber/` | `network-graph` (React Flow topology, `ssr:false`), `incident-replay` (animated 7-phase timeline, speeds 0.5–5×) |
| `agents/` | `agent-panel` (slide-in detail: runs, cost/latency/tokens, memories) |
| `company/` | `org-graph` (React Flow org chart, `ssr:false`) |
| `code/` | `code-view` (line numbers, copy, small built-in JS/TS/JSON/MD highlighter) |
| `auth/` | `auth-form` (sign-in / register on `/api/auth/*`) |
| `ui/` | `primitives` (Card, Badge, AgentAvatar, StatusBadge, AnimatedNumber, Skeleton, EmptyState), `toaster` |

## Pages under `app/[id]/`

`page` (dashboard), `agents`, `projects` (kanban by `TASK_STATUSES`), `code`
(workspace browser), `deployments`, `cyber-range`, `incidents`, `infrastructure`,
`analytics` (DORA + Recharts), `decisions`, `activity`, `company` (org chart),
`settings` (AI mode/models/budget, delete company). `layout.tsx` renders the
shell and polls `/api/companies/[id]` (8s) + `/usage` (10s).

## Conventions

- **Design tokens live in `src/lib/theme.ts`** (palette, validated chart series) and feed
  `tailwind.config.ts`; component classes (`.page`, `.page-header`, `.btn-*`, `.table`,
  `.tabs`, `.segmented`, `.chip`, `.well`) are in `src/app/globals.css`. Shared React
  primitives (`PageHeader`, `Section`, `StatusBadge`, `StatusDot`, `EmptyState`,
  `ErrorState`, `SimulatedNotice`) are in `components/ui/primitives.tsx`.
- The accent (`brand`, lime) is reserved for the single primary action, focus rings
  and live/active state. Status is never color-only (always a text label).
- Styling via `cn()` (clsx + tailwind-merge). Colors are semantic Tailwind tokens
  (`bg`, `border`, `text`, `brand`, `danger`, `success`, `warning`, `info`) — see
  `tailwind.config.ts`; don't hardcode hex.
- Dynamic-import React Flow graphs with `{ ssr: false }`.
- Format with `formatCurrency/formatNumber/formatPercent/timeAgo` from `@/lib/utils`.
- New data viz? Read the `dataviz` skill first.

See [frontend-patterns](../engineering/frontend-patterns.md) for the "how to add a
page/panel" recipe.
