# Prompt: database changes

**When to use** — change the Prisma schema safely.

**What to provide** — the data change and why.

## The prompt

```
Use the `aura-database-change` skill. Change AURA's schema:

CHANGE: [WHAT_DATA_CHANGE]
WHY: [REASON]

1. Read prisma/schema.prisma and how the affected models are queried. Note
   relationships + existing indexes.
2. Design the SMALLEST, data-preserving change (prefer additive nullable/defaulted
   columns). Confirm existing rows + JSON columns still parse (parseJSON fallbacks).
3. Edit the schema. For enum-like String fields, update the comment AND the union
   tuple in src/lib/types.ts. Add @@index for new query patterns; @@unique for keys.
4. Apply with `npm run db:push` (NOT db:reset — that destroys data). Run
   `npm run db:generate` if client types are stale.
5. Update app types, queries, and affected route Zod schemas. Extend prisma/seed.ts
   if the demo should showcase it.
6. Add a test that reads/writes the new field. State a rollback plan.
7. RUN npm run typecheck && npm test. Update docs/architecture/database.md.

Never casually reset or delete the database to resolve a migration problem.
```

## Expected deliverables
Minimal additive schema change, synced types/queries, seed + test updated, rollback
noted, docs updated.

## Verification
`db:push` succeeds without data loss; typecheck + tests green.

## Common failure modes
Destructive change; enum value missing from `types.ts`; `db:reset` as a fix;
forgetting `db:generate`.
