# Workflow: adding a feature

Skill: `aura-feature`. Worked example: [../getting-started/first-feature.md](../getting-started/first-feature.md).

A feature is a **vertical slice**. Avoid frontend-only when backend work is needed.

1. **Understand** the user story + acceptance criteria. Write them down.
2. **Inspect** the existing implementation — grep, read the nearby route/workflow/
   component. Reuse before adding. ([repository-map](../architecture/repository-map.md))
3. **Trace** the request through its layers: page → `useQuery/useMutation` → route
   (`handler`→authz→`parseBody`) → workflow/`lib` → prisma → `emitEvent`.
4. **Plan** the smallest change touching only the layers it must: DB? types? API?
   workflow? component?
5. **Security & data**: tenant scope, `requireWorkspaceAccess` role, input
   validation, untrusted AI/user content.
6. **Implement** back-to-front: schema → types → API (Zod + authz) → domain logic
   in `lib` → UI with primitives + hooks. Emit events for state changes.
7. **Test**: pure logic unit test; cross-workspace denial test for a new route;
   e2e if a journey changed. **Run them.**
8. **Verify the journey** in the real app (`run` skill / `AURA_DIST_DIR=... npm run dev`).
9. **Docs**: update any changed contract. ([DoD](../engineering/definition-of-done.md))
