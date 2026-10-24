# Human-in-the-loop design

Which actions are autonomous and which require a human — and the hard rule that
**approval is enforced by the backend, not a frontend dialog.**

## AURA's gate

- `requestDeploy(companyId, env)` (`workflows/approval.ts`): a **production** deploy
  always creates a `PENDING_APPROVAL` deployment with a real change summary + risk
  assessment. Non-prod under `AUTONOMOUS` can ship directly.
- `resolveApproval(companyId, deploymentId, decision)`: `approve` runs the real
  pipeline; `reject` cancels. The approve route requires `MEMBER` and is
  server-checked — the UI button is just a trigger.
- The autonomy level (`ASSISTED` / `BALANCED` / `AUTONOMOUS`) tunes how much gates,
  but production always gates.

## Risk tiers (guidance)

| Action | Default |
|---|---|
| Analysis, read-only summaries | autonomous |
| Drafting code **inside the sandbox** | autonomous (sandbox is the boundary) |
| Modifying shared infra / config | restricted |
| Production deployment | approval (configurable by autonomy) |
| Destructive DB changes | explicit approval |
| Sensitive security actions (e.g. real attack — N/A here, range is simulated) | strict authorization |

## Rules

1. **Backend enforces.** The gate is a persisted `PENDING_APPROVAL` state + a
   server-side authorization check on resolve. A frontend confirm dialog is UX, not
   security. Never implement approval as "the UI asked and the user clicked yes".
2. **Record the decision.** Who approved/rejected, when, and the change summary —
   audit it. (`Deployment` + `AuditLog`.)
3. **Default to gating consequential/irreversible actions**, and anything
   outward-facing or destructive, unless durably authorized.
4. **Autonomy is bounded by code**, not vibes — even `AUTONOMOUS` can't bypass the
   production gate, budget hard-stop, or permissions.

## Adding an approval gate

1. Introduce a `PENDING_*` state on the entity (don't perform the action yet).
2. Emit an event / attention item so a human sees it (the attention panel surfaces
   `PENDING_APPROVAL` deploys).
3. Add a resolve route with the right `requireWorkspaceAccess` role that performs
   the action only on approve, and audits the decision.
4. Test both paths and that an unauthorized user can't resolve.
