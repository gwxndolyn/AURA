# Tenant isolation

`Company` is the tenant root. Isolation is enforced in **code**, not the DB.

## The choke point

`src/lib/auth/authz.ts`:

```ts
await requireWorkspaceAccess(companyId, minRole);  // VIEWER | MEMBER | ADMIN | OWNER
```

- 401 if unauthenticated.
- **404 if the user is not a member** — deliberately not 403, so we don't leak that
  another workspace exists.
- 403 if a member but below `minRole`.
- Owner implicitly has OWNER even without a membership row.

Role ranks: `ROLE_RANK = { VIEWER:0, MEMBER:1, ADMIN:2, OWNER:3 }`.
`accessibleCompanyIds(userId)` lists owned + member companies (used to scope list
endpoints).

## Mandatory patterns

1. **Call `requireWorkspaceAccess` first** in every company-scoped route, with the
   right role (read=VIEWER, mutate=MEMBER, destroy=OWNER).
2. **Scope every query by `companyId`.**
3. **Nested ids → `findFirst({ where: { id, companyId } })`**, never
   `findUnique({ where: { id } })` alone. This is how the two historical IDOR bugs
   (agents, availability) were fixed.

```ts
// ✅ safe
const task = await prisma.task.findFirst({ where: { id: taskId, companyId } });
// ❌ IDOR — returns another tenant's row
const task = await prisma.task.findUnique({ where: { id: taskId } });
```

4. **List endpoints** scope by `accessibleCompanyIds` or `where: { companyId }`.
5. **Middleware** (`middleware.ts`) blocks unauthenticated `/app` + `/api/companies`
   as a first line — but the route-level check is the authority.

## Tested

`src/lib/auth/isolation.test.ts` asserts: owner access works; cross-user read/write
denied; swapping the company id doesn't bypass authz; task/agent scoping; role
hierarchy; and the auth primitives (password hash round-trip, session
sign/verify/tamper-reject). Add a cross-workspace denial test for **every** new
company route.

## Background jobs & agents

Agents and workflows run under a `companyId` and must obey the same scoping —
they're not exempt because they're "internal". The tool runner audits per company;
memory retrieval is per agent/company. Never let a workflow read across tenants.
