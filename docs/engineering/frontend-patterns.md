# Frontend patterns

See [../architecture/frontend.md](../architecture/frontend.md) for the inventory.
This is the "how to add one" recipe.

## Add a page under `app/[id]/`

1. Create `src/app/app/[id]/<name>/page.tsx` with `"use client"`.
2. Read the company id from the shell (it's in the Zustand store and the route).
3. Fetch with `useQuery`; mutate with `useMutation`:

   ```ts
   "use client";
   import { useQuery, useMutation } from "@/hooks/useApi";
   export default function MyPage() {
     const id = /* from params/store */;
     const { data, loading, refetch } = useQuery<MyData>(`/api/companies/${id}/my-thing`, 6000);
     const { mutate } = useMutation("POST");
     // ...
   }
   ```

4. Add a nav entry in `src/components/shell/nav.ts` (used by the sidebar, mobile drawer
   and breadcrumb) and a command in `command-palette.tsx`. Start the page with
   `<div className="page">` + `<PageHeader …/>`; handle loading (`Skeleton`), empty
   (`EmptyState`) and failed (`ErrorState` with retry) states.
5. Use `src/components/ui/primitives.tsx` (Card, Badge, StatusBadge,
   AnimatedNumber, Skeleton, EmptyState) and `cn()`.

## Live updates

```ts
import { useLiveEvents } from "@/hooks/useLiveEvents";
const { events, version, connected } = useLiveEvents(id, 60);
// refetch when relevant events arrive:
const { data } = useQuery(`/api/companies/${id}/overview`, 6000);
useEffect(() => { refetch(); }, [version]);
```

Render events with `ActivityFeed`; it colors by `level`.

## Loading & empty states

Always handle `loading` (use `Skeleton`) and empty data (`EmptyState`). Don't block
the whole page on one slow query — the shell already polls company + usage.

## Styling

- Semantic Tailwind tokens only; dark-first. No raw hex.
- Animations via Framer Motion, consistent with existing components.
- React Flow graphs: dynamic-import with `{ ssr: false }` (see `org-graph`,
  `network-graph`).

## Charts / data viz

Read the `dataviz` skill before writing any chart (Recharts is already a dep). Keep
color semantics consistent across light/dark.

## Don't

- Don't put authorization logic in the client — it's cosmetic; the backend decides.
- Don't fetch with bare `fetch`; use the hooks so the `{ ok, data }` envelope and
  errors are handled uniformly.
- Don't introduce a client state library beyond Zustand.
