# Prompt: integration debugging

**When to use** — a failure that crosses boundaries (frontend ↔ API ↔ queue/bus ↔
DB ↔ model provider).

**What to provide** — the symptom and where it surfaces.

## The prompt

```
Use the `aura-debug` skill. Trace this cross-boundary failure in AURA:

SYMPTOM: [WHAT_THE_USER_SEES]
SURFACES AT: [PAGE / ROUTE / AGENT]

Trace the full path and locate exactly where it breaks:
1. Frontend: the useQuery/useMutation call + the {ok,data} envelope handling and
   the useLiveEvents SSE subscription.
2. API: the route — handler(), requireWorkspaceAccess, parseBody, status/shape.
3. Domain: the lib/workflow function; prisma scoping (companyId); event emission.
4. Realtime: emitEvent → in-process bus → SSE stream → client. (Single-instance
   only — check if multiple instances are involved.)
5. Model/sandbox: complete() mode (live/simulation), fallback flag; sandbox
   docker/simulated.

Collect evidence at each hop ([api error] logs, /activity, /audit, network tab,
/api/health, /api/ai/status). Name the exact boundary that fails and the root
cause, then make a targeted fix + regression test. RUN the relevant checks.
```

## Expected deliverables
The exact failing boundary, root cause, fix, and a regression test.

## Verification
The traced hop is confirmed broken then fixed; the end-to-end journey works.

## Common failure modes
Guessing the layer; not checking the SSE/bus single-instance assumption; confusing
simulation-mode output for a bug.
