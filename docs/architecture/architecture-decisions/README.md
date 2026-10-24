# Architecture Decision Records (ADRs)

Short, dated records of significant, hard-to-reverse decisions and *why*. Add one
when you make a choice a future developer would otherwise have to reverse-engineer.

Format (keep it to one screen):

```markdown
# ADR-00NN: <title>
Date: YYYY-MM-DD · Status: Accepted | Superseded by ADR-xxxx

## Context
What forces are at play? What problem?

## Decision
What we chose.

## Consequences
Trade-offs, what becomes easier/harder, follow-ups.
```

## Existing decisions (captured from the codebase)

These are documented in [../overview.md](../overview.md#core-design-decisions);
promote any to a numbered ADR if it needs fuller treatment:

1. **SQLite + Prisma by default; enums as validated strings.** Zero-config local
   dev; Postgres optional. Enum unions live in `src/lib/types.ts`.
2. **Single model entry point (`src/lib/ai/claude.ts`) + deterministic offline
   simulator.** One place for routing/cost/fallback; the whole app runs with no
   API key.
3. **Security score computed from real state**, never asked of the model
   (`src/lib/company/security.ts`).
4. **In-process event bus + SSE** instead of Redis — single-process realtime with
   zero infra.
5. **UI-driven simulation ticks** instead of a server scheduler — serverless-safe.
6. **Auth without new deps** — Node `crypto` HMAC sessions (install of `jose`
   repeatedly failed on the OneDrive filesystem); a Web Crypto twin for edge
   middleware.
7. **Real Docker sandbox for generated code**, with a flagged simulated fallback.
