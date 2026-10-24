# Database

Prisma ORM. **SQLite by default** (`prisma/dev.db`), Postgres optional. The schema
is `prisma/schema.prisma`. Access only through the `prisma` singleton in
`src/lib/db.ts` — never raw SQL.

## SQLite conventions (important)

- **No native enums.** Every "enum" field is a `String` with the allowed values in
  a comment and validated in app code via the union tuples in `src/lib/types.ts`
  (and Zod at the API edge). When you add a status value, update **both** the
  schema comment and `types.ts`.
- **JSON as String.** Array/object fields (`acceptance`, `dependsOn`, `stages`,
  `timeline`, `permissions`, `files`, `meta`, …) are stored as JSON strings.
  Read with `parseJSON<T>(value, fallback)` from `src/lib/utils.ts`; write with
  `JSON.stringify`. Never trust the shape — always pass a fallback.
- **cuid ids**, `createdAt`/`updatedAt` timestamps, cascade deletes from `Company`.

## Tenancy

`Company` is the tenant root. Almost every model has `companyId` + an index, and
most include `@@index([companyId, ...])`. Access control is enforced in
`requireWorkspaceAccess` (see [../security/tenant-isolation.md](../security/tenant-isolation.md)),
not by the DB. **Always scope queries by `companyId`.**

Membership: `User` → `WorkspaceMember(userId, companyId, role)` → `Company`. Roles
`OWNER | ADMIN | MEMBER | VIEWER`, ranked in `authz.ROLE_RANK`.

## Model groups

| Group | Models |
|---|---|
| Identity & tenancy | `User`, `WorkspaceMember`, `PasswordResetToken`, `Company` |
| Agents | `Agent` (incl. `available`, `permissions` JSON), `AgentMessage`, `AgentMemory`, `AgentRun`, `ToolCall` |
| Work | `Project`, `Sprint`, `Task` (incl. `businessImpact`, `urgency`, `securityRisk`, `priorityScore`, `attempts`) |
| Delivery | `Deployment` (stages JSON), `CodeWorkspace` (files JSON) |
| Security & ops | `Incident`, `SecurityFinding`, `InfrastructureNode` |
| Simulation & insight | `SimulationEvent`, `Customer`, `Decision`, `Metric`, `AuditLog`, `TimelineEvent` |

Key enum-like fields (validated in `types.ts`): `Company.status`
(`BUILDING|OPERATING|INCIDENT|UNDER_ATTACK|RECOVERING`), `Company.autonomy`
(`ASSISTED|BALANCED|AUTONOMOUS`), `Agent.status`
(`IDLE|THINKING|WORKING|WAITING|BLOCKED|FAILED|COMPLETED`), `Task.status`
(`BACKLOG|PLANNED|IN_PROGRESS|REVIEW|TESTING|DONE|BLOCKED`), `Task.priority` /
`*.severity` (`LOW|MEDIUM|HIGH|CRITICAL`).

## Changing the schema (summary)

Use the `aura-database-change` skill. In short:

1. Edit `prisma/schema.prisma` — smallest change that works; add indexes for new
   query patterns; keep enum values in sync with `types.ts`.
2. `npm run db:push` (dev; SQLite). This updates `dev.db` **without** dropping data
   for additive changes. **Never** reach for `db:reset` to "fix" a migration — it
   force-resets and reseeds, destroying local data.
3. `npm run db:generate` (regenerate the client) if types are stale.
4. Update app types (`types.ts`), queries, and this doc.
5. Add/adjust a test; run `npm run typecheck` and `npm test`.

> There is **no SQL migration history** committed (SQLite + `db push`). For a real
> Postgres deployment, switch the datasource provider and adopt `prisma migrate`.
> Full guide: [../workflows/changing-a-database-schema.md](../workflows/changing-a-database-schema.md).
