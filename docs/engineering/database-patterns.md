# Database patterns

Reference: [../architecture/database.md](../architecture/database.md). Change
workflow: [../workflows/changing-a-database-schema.md](../workflows/changing-a-database-schema.md)
(`aura-database-change` skill).

## Access

- Only through `prisma` from `@/lib/db` (singleton on `globalThis`). No raw SQL, no
  new `PrismaClient`.
- **Scope by `companyId`** in every query. Nested ids:
  `findFirst({ where: { id, companyId } })`.

## Enum-like fields

Stored as `String` (SQLite has no enums). The allowed set lives in the schema
comment **and** `src/lib/types.ts`. When adding a value:

1. Add it to the schema comment on that field.
2. Add it to the matching tuple in `types.ts`.
3. `npm run db:push` (no migration needed for a comment/validation change).

## JSON columns

`acceptance`, `dependsOn`, `stages`, `timeline`, `evidence`, `options`,
`consulted`, `permissions`, `files`, `meta` are JSON **strings**.

```ts
const criteria = parseJSON<AcceptanceCriterion[]>(task.acceptance, []);  // read
await prisma.task.update({ where: { id }, data: { acceptance: JSON.stringify(next) } });  // write
```

Never `JSON.parse` without a fallback; the column may be `"{}"`/`"[]"`/malformed.

## Indexes

Add `@@index([companyId, <field>])` for any new query pattern you introduce (most
models already index `companyId` and a status). Unique business keys use
`@@unique` (e.g. `Agent @@unique([companyId, key])`,
`WorkspaceMember @@unique([userId, companyId])`).

## Migrations

Local dev uses `prisma db push` against SQLite — **no committed migration
history**. Additive changes are safe. **Never** use `npm run db:reset` to "fix" a
schema problem; it force-resets and reseeds, destroying data. For production
Postgres, switch the datasource provider and adopt `prisma migrate` with a proper
migration history (documented as a next step).

## Seeding

`prisma/seed.ts` is idempotent — it deletes the prior "NOVA PAY" demo first. If you
add models/fields that the demo should showcase, extend the seed so the demo stays
representative.
