---
paths: ["src/app/**/*.tsx", "src/components/**/*.tsx", "src/hooks/**/*.ts", "src/lib/store.ts"]
---

# Frontend rules

Full detail: `docs/architecture/frontend.md`, `docs/engineering/frontend-patterns.md`.

- Interactive pages/components start with `"use client"`. Keep the root layout +
  landing as server components.
- Fetch via `useQuery` / `useMutation` / `fetchJSON` from `@/hooks/useApi` — never
  bare `fetch`. They unwrap the `{ ok, data }` envelope and handle errors.
- Live updates via `useLiveEvents(companyId, max)` (SSE); refetch off its `version`.
- Global state via the Zustand `useApp` store (`@/lib/store`): `companyId`, toasts,
  command palette. Don't add another client state library.
- Reuse `src/components/ui/primitives.tsx` (Card, Badge, StatusBadge,
  AnimatedNumber, Skeleton, EmptyState). Handle loading + empty states.
- Styling: semantic Tailwind tokens only (`bg`, `border`, `text`, `brand`,
  `danger`, `success`, `warning`, `info`) — no raw hex. Compose with `cn()`.
  Format via `@/lib/utils` (`formatCurrency`/`formatNumber`/`formatPercent`/`timeAgo`).
- Dynamic-import React Flow graphs with `{ ssr: false }`.
- **Never** put authorization logic in the client — it's cosmetic; the backend is
  the authority. Never read a secret client-side (only `NEXT_PUBLIC_*` reaches the
  browser).
- Tokens: `src/lib/theme.ts` (never hardcode hex; charts use `chart.series` in fixed order).
  Accent is for the one primary action / focus / live state only.
- New page → `.page` + `PageHeader`, add an entry in `components/shell/nav.ts` and (optionally) a command-palette
  command. Read the `dataviz` skill before writing any chart.
