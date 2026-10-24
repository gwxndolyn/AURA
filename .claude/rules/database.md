---
paths: ["prisma/**", "src/lib/db.ts", "src/lib/types.ts"]
---

# Database rules

Full detail: `docs/architecture/database.md`, `docs/engineering/database-patterns.md`.

- SQLite by default; **no native enums** — enum-like fields are `String` validated
  by the union tuples in `src/lib/types.ts`. Add a new value to BOTH the schema
  comment and `types.ts`.
- JSON columns are stored as strings. Read with `parseJSON<T>(value, fallback)`
  (always a fallback); write with `JSON.stringify`.
- Apply schema changes with `npm run db:push` (additive-safe). **Never** use
  `npm run db:reset` to "fix" a problem — it force-resets and destroys data.
- Prefer additive, data-preserving changes. Add `@@index([companyId, ...])` for new
  query patterns; `@@unique` for business keys.
- `Company` is the tenant root; keep `companyId` on new models and scope queries by
  it. Regenerate the client (`npm run db:generate`) when types go stale.
- Keep `prisma/seed.ts` idempotent and representative — extend it when a new model/
  field should appear in the NOVA PAY demo.
- No committed migration history (SQLite + `db push`); for production Postgres,
  switch the provider and adopt `prisma migrate`.
