# TypeScript standards

`tsconfig.json`: target ES2022, `strict: true`, `moduleResolution: "bundler"`,
`noEmit`, path alias `@/* → ./src/*`. `typescript.ignoreBuildErrors` is **false**
in `next.config.mjs` — type errors fail the build. Run `npm run typecheck` often.

## Rules

- **No `any`** without a one-line justification comment. Prefer `unknown` + a
  narrowing check, or a precise type.
- **Reuse the union tuples** in `src/lib/types.ts` for all enum-like values:
  `AgentStatus`, `CompanyStatus`, `TaskStatus`, `Priority`, `Severity`, `Autonomy`,
  `ModelTier`, `EventType`. Don't inline string literals that duplicate these.

  ```ts
  import { TASK_STATUSES, type TaskStatus } from "@/lib/types";
  // Zod at the edge:
  z.object({ status: z.enum(TASK_STATUSES) })
  ```

- **Validate external data, don't cast it.** Request bodies → `parseBody(req,
  ZodSchema)`. JSON stored as strings → `parseJSON<T>(value, fallback)` (always a
  fallback; never `JSON.parse` + cast). Model output → parse/validate before use.
- **Prisma types** are the source of truth for rows — import and use them rather
  than redeclaring shapes. JSON string columns are typed `string`; parse to your
  own interface on read.
- **Return types on exported functions** in `src/lib` — they're the public surface
  of each module.
- **Discriminated unions over booleans** for multi-state results (mirrors
  `GuardVerdict`, `CompletionResult.mode`).

## Async

- `await ctx.params` in Next 15 dynamic routes (params is a `Promise`).
- Parallelize independent awaits with `Promise.all` (as `authz.ts` and
  `security.ts` do).
- No floating promises — `await` or explicitly handle them.

## Client vs server

- Server-only code must not leak to the client. Secrets and the Anthropic client
  stay server-side. Only `NEXT_PUBLIC_`-prefixed env vars reach the browser.
- Client components start with `"use client"`; keep server components the default
  where interactivity isn't needed.
