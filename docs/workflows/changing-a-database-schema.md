# Workflow: changing the database schema

Skill: `aura-database-change`. Patterns: [../engineering/database-patterns.md](../engineering/database-patterns.md).

1. **Inspect** the current schema + how the affected models are queried. Understand
   relationships and existing indexes.
2. **Design the smallest change.** Prefer additive (new nullable/defaulted column)
   over destructive. Preserve existing data.
3. **Backward compatibility** — will existing rows and JSON columns still parse?
   Keep `parseJSON` fallbacks valid.
4. **Edit** `prisma/schema.prisma`. For enum-like `String` fields, update the
   comment **and** the union tuple in `src/lib/types.ts`. Add `@@index` for new
   query patterns; `@@unique` for business keys.
5. **Apply** — `npm run db:push` (SQLite, additive-safe). **Never** `db:reset` to
   "fix" a problem — it drops all data.
6. **Regenerate** — `npm run db:generate` if client types are stale.
7. **Update** app types, queries, and any affected route schemas.
8. **Test** — a test that reads/writes the new field; migration/seed still works.
   Extend `prisma/seed.ts` if the demo should showcase it.
9. **Rollback plan** — know how to revert (restore `dev.db`/volume; for Postgres,
   a down migration). Document it.
10. **Docs** — update [../architecture/database.md](../architecture/database.md).

> SQLite + `db push` has **no committed migration history**. For production
> Postgres, switch the provider and adopt `prisma migrate`.
