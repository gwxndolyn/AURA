# Workflow: adding a security control

Skill: `aura-security-audit`. Model: [../security/threat-model.md](../security/threat-model.md).

1. **Name the threat** the control addresses (from the threat model). A control
   without a threat is noise.
2. **Enforce in code**, not prompt wording. Authority lives in the backend.
3. **Pick the layer:**
   - Access → `requireWorkspaceAccess` / query scoping.
   - Agent capability → `ROLE_PERMISSIONS` + `callTool`.
   - Input → Zod at the boundary; output → validate before use.
   - Execution → the sandbox flags.
   - Budget/loops → `guardrails`.
4. **Default to least privilege / fail closed.**
5. **Audit** the control's decisions (`audit`); surface violations (attention
   panel / events).
6. **Test it** — a test that proves the control blocks the bad case (e.g.
   cross-workspace 404, denied tool, rejected input). Mirror `isolation.test.ts` /
   `permissions.test.ts`.
7. **Document** — update the threat model + the specific security doc, and this
   repo's [SECURITY.md](../../SECURITY.md) table if it's a new control class.

Never test a control by attacking a real external system. For the cyber range, use
only the isolated simulation.
