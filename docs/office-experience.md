# The living office

A miniature voxel studio where each AI role is a distinct character. It is a
**view** of persisted work: the renderer never decides what an agent is doing.

| Piece | Where |
|---|---|
| Layout: grid 28×18, locations, seats, obstacles, homes | `src/lib/office/layout.ts` |
| Deterministic A* pathfinding (4-connected, no corner cutting) | `src/lib/office/pathfinding.ts` |
| State mapper (execution → visual) | `src/lib/office/state.ts` (`mapOfficeState`) |
| Character specs (hair, outfit, accessory, palette) + 2D sprites | `src/lib/office/characters.ts` |
| Live snapshot for a workspace | `src/lib/office/live.ts`, `GET /api/companies/[id]/office` (VIEWER) |
| 3D renderer (plain Three.js, procedural voxels) | `src/components/office/scene.ts` |
| React wrapper, mode selection, controls | `office-view.tsx`, `webgl.ts` |
| 2D fallback / mobile office | `office-2d.tsx` |
| Inspectors (agent, location) | `agent-inspector.tsx` |
| Live page | `src/app/app/[id]/office/page.tsx` |
| Landing demo | `landing-demo.tsx`, `src/lib/office/demo-script.ts`, `recording.ts` |

## Rendering and assets

Plain `three` (no React Three Fiber; ~670 KB minified) loaded with a dynamic
import only when the 3D office mounts, so the rest of the app and the 2D mode
never download it. All geometry is generated in code — no external models,
textures or paid assets. Lighting is a warm key light with soft shadows plus
ambient fill. Pixel ratio is capped at 1.75; the render loop pauses when the
canvas is offscreen or the tab is hidden.

## Locations ↔ AURA concepts

| Location | Shows |
|---|---|
| Planning | REQUIREMENTS / ARCHITECTURE / ANALYSIS tasks, PM/architect product work |
| Design studio | designer work, PROPOSED design artifacts |
| Engineering desks | CODE_CHANGE tasks that are RUNNING |
| QA lab | TEST / REPRODUCE tasks that are RUNNING |
| Collaboration table | REVIEW tasks, handoffs between agents |
| Security corner | SECURITY_REVIEW tasks |
| Release station | WAITING_APPROVAL tasks / pending approvals |
| Lounge | idle |

## State synchronisation

`mapOfficeState` (pure, unit-tested) is the only place visual state is
derived:

- RUNNING mission task → planning / coding / testing / reviewing at that
  kind's location. Only RUNNING shows work — an approved plan with nothing
  running shows nobody coding.
- WAITING_APPROVAL → awaiting approval at the release station.
- FAILED task in an open mission, or an unavailable agent → blocked (slumped
  pose), never completed.
- SUCCEEDED within the last 5 minutes → completed (celebration), then idle.
- No mission task: product items IN_PROGRESS/BLOCKED and PROPOSED design /
  architecture artifacts → designing / planning / blocked / awaiting review.
  Backlog items have no owner field; the first capability is shown as owner.
- Expired leases are flagged *stale* rather than animated.

Interactions (agents turning to face each other, a packet travelling between
them) come only from persisted `MissionHandoff` / findings rows — or, on the
landing page, from the demo script, labelled as demo. The live page refetches
on SSE events (`useLiveEvents`) and animates from the state change; no model is
ever called for movement.

## Navigation, accessibility, fallbacks

Click/tap an avatar or area to inspect it; drag to pan, scroll/+/− to zoom;
Esc or the target button returns to the overview; a first-time hint explains
this. Every agent and area is also a focusable button. The 2D pixel office is
used when WebGL is unavailable, below 768 px wide, or with `?office=2d`, and
is fully keyboard-operable. `prefers-reduced-motion` → instant moves and no
animation loop. The engineering pages (Products, Missions, Code) never require
the office.

## Adding a character or location

- **Character**: add the agent to `agents/definitions.ts` (+ permissions,
  capabilities), add a `CharacterSpec` in `characters.ts` and a `HOME` seat in
  `layout.ts`. `office.test.ts` asserts every real agent has a character and
  home.
- **Location**: add an `OfficeLocation` with seats on walkable cells and its
  obstacles in `layout.ts`, map task kinds in `locationForTaskKind`, and add
  geometry in `scene.ts`. `validateLayout()` (tested) checks seats are
  reachable and don't overlap obstacles.

## Limitations

The 3D path has been exercised only under software WebGL (SwiftShader) in
tests, not on a real GPU. There is no route-level test that a live state change
animates a walk (covered at the mapper and seat-allocation level). Two agents
are both named "Iris", so the office shows "Iris · QA" and "Iris · Reviewer".
