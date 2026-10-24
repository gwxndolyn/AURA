# Testing strategy

Two layers today: **Vitest** unit tests (`src/**/*.test.ts`, node env) and
**Playwright** e2e (`e2e/*.spec.ts`). Use the `aura-test` skill to choose and build
tests. Reference: [../ai-engineering/evaluation-and-testing.md](../ai-engineering/evaluation-and-testing.md)
for probabilistic/AI behavior.

## What exists (8 unit files + 1 e2e)

| File | Covers |
|---|---|
| `src/lib/agents/definitions.test.ts` | registry: unique keys/colors/tiers, red-team prompt is sandbox-constrained |
| `src/lib/agents/permissions.test.ts` | role allowlists: red-team can attack not deploy, only engineers write code, etc. |
| `src/lib/ai/pricing.test.ts` | price-by-family, fallback, cost estimate |
| `src/lib/ai/simulator.test.ts` | structured plans, security goals→security tasks, determinism per seed, attack/test shapes |
| `src/lib/auth/isolation.test.ts` | tenant isolation + IDOR, role hierarchy, password + session primitives |
| `src/lib/sandbox/runner.test.ts` | real Docker sandbox: passing/failing tests, syntax-fail build, every template passes (auto-skips without Docker) |
| `src/lib/utils.test.ts` | clamp, parseJSON, seededRandom, hashString, formatting |
| `src/lib/workflows/prioritize.test.ts` | scoring: security weighted most, dependents reward, effort penalty |
| `e2e/journey.spec.ts` | landing, onboarding→dashboard, full API workflow, stress-test invariants, cyber-range |

## Choosing the test type

| You changed… | Write… |
|---|---|
| Pure logic (scoring, formatting, parsing) | Vitest unit, no DB (mirror `prioritize.test.ts`) |
| Permissions / registry | Vitest unit (mirror `permissions.test.ts`) |
| Auth / tenant scoping | Vitest + the isolation patterns (cross-workspace must 404) |
| Sandbox / codegen | Vitest `runner`-style (guard on `dockerAvailable()`) |
| A user journey / multi-route workflow | Playwright e2e |
| AI prompt/agent behavior | eval cases — see `aura-ai-evaluation` + the AI testing doc |

## Principles

- **Extract pure logic and unit-test it** (like `scoreTask`) — fast, no DB.
- **Determinism:** the simulator is seeded; assert stable output for a seed rather
  than exact prose. For live-model behavior, assert schema/shape and invariants,
  not exact strings.
- **Security tests are first-class:** every new company route should have a
  cross-workspace denial test; every new tool a permission test.
- **Real over mock:** the sandbox tests run real `node --test`. Don't replace real
  behavior with a mock just to go green. Guard environment-dependent tests
  (`if (!(await dockerAvailable())) return` style) instead of faking.
- **Run them.** Never claim a test passed without executing it.

## Commands

```bash
npm test                 # vitest run
npm run test:watch       # vitest watch
npm run test:e2e         # playwright (needs: npm run test:e2e:install once)
```

Playwright starts its own dev server with `AURA_DIST_DIR=/tmp/aura-next-e2e`
(configured) — don't start a conflicting one on the same port.
