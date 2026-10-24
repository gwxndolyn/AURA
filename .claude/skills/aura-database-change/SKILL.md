---
name: aura-database-change
description: Change the AURA Prisma schema safely — smallest additive migration, data preservation, enum/types sync, indexes, updated queries/types, tests, rollback. Use when modifying prisma/schema.prisma. Never resets the database to fix migrations.
---

# aura-database-change

## When to use
Any change to `prisma/schema.prisma` or the data model.

## Required context
`docs/architecture/database.md`, `docs/engineering/database-patterns.md`,
`docs/workflows/changing-a-database-schema.md`.

## Workflow
1. Inspect current schema + how affected models are queried; note relationships +
   indexes.
2. Design the **smallest, data-preserving** change (prefer additive nullable/
   defaulted). Confirm existing rows + JSON columns still parse.
3. Edit the schema. Enum-like `String` fields: update the comment AND the union in
   `src/lib/types.ts`. Add `@@index` for new queries; `@@unique` for keys.
4. Apply with `npm run db:push` (additive-safe). Run `npm run db:generate` if types
   are stale.
5. Update app types, queries, affected route Zod schemas. Extend `prisma/seed.ts`
   if the demo should showcase it.
6. Add a test reading/writing the new field; state a rollback plan.
7. `npm run typecheck && npm test`; update `docs/architecture/database.md`.

## Hard rule
**Never** `npm run db:reset` to resolve a migration problem — it destroys data.
No committed migration history (SQLite); production Postgres uses `prisma migrate`.

## Security
Keep `companyId` on new models; scope queries by it.

## Definition of done
Minimal additive change; types/queries/seed synced; test + rollback; typecheck +
tests green; docs updated.

## Final report
Schema change · types/queries updated · `db:push` result · test added · rollback
plan · docs updated.
