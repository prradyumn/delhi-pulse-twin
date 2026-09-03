# 00 — Delhi Pulse Twin: delivery plan

Read alongside the PRD (v1.1, scope-locked). This plan does not re-decide anything the PRD locked; it
turns the locked scope into an executable sequence, and flags four places where the PRD contradicts
itself or the hardware.

- `01-SCOPE-LOCK.md` / `config/study-area.json` — frozen bounds, corridors, budgets
- `02-ARCHITECTURE.md` — no-backend design, repo layout, data contracts, scenario maths
- `03-BLENDER-PIPELINE.md` — **the headless-vs-headed decision and its evidence**
- `04-DATA-REGISTER.md` — licensing gate every dataset passes before it enters the build
- `05-DECISIONS.md` — ADR log, including the PRD's own open decisions
- `06-SPIKE-0.md` — the 2-day gate before any visual production

## Strategy in one paragraph

Build the honest, offline-capable core first and treat every live feed as decoration that can be
deleted. Measure the two things that can actually kill the project — OSM completeness and 3D
performance on an 8 GB M1 — in the first two days, before a single landmark is modelled. Keep the
geography frozen and spend the saved time on provenance, scenario transparency and the guided story,
because those are what make the demo credible and what a reviewer can actually evaluate.

## Phases and gates

| Phase | PRD duration | What ships | Exit gate |
|---|---|---|---|
| **0 · Discovery + Spike-0** | 1–2 wk | User interviews; data/licensing register; OSM audit; bake-off measurements; bounds LOCKED | One validated problem, a feasible data plan, and a measured bake-vs-runtime decision |
| **1 · Thin vertical slice** | 2 wk | One corridor, basic 3D, one static bus route, provenance drawer | map → select → evidence works end-to-end and holds ≥30 FPS |
| **2 · MVP foundation** | 3 wk | 16-tile city, layer system with independent failure, time state, snapshot fallback, detail drawer | Default scene stable inside the load/FPS/transfer budgets |
| **3 · Scenario Lab** | 3 wk | Bus-frequency + rainfall-stress scenarios, baseline compare, visible metric formulas | Both scenarios pass the truthfulness and exact-reset tests |
| **4 · Story + landmarks + polish** | 2 wk | Onboarding, guided tour, **landmark sprint (headed Blender + MCP, ≤3 days)**, export, error states | Five-minute demo succeeds with no explanation and no live feeds |
| **5 · Evaluation + case study** | 2 wk | 5-user moderated test, benchmark table, demo video, case study | Measured outcomes and an honest retrospective |
| Buffer | 2 wk | Provider issues, optimisation, fixes | Release candidate |

## Phase 0 task board (maps onto the PRD's "first 10 build tasks")

1. **Rename the project directory.** It is currently `DIGITAL TWIN PROJECT ` — with a trailing
   space. That will bite npm scripts, Blender `--python` argv, and Vercel builds in ways that are
   annoying to diagnose. `~/delhi-pulse-twin`. Do it before `git init`.
2. `git init`, commit the PRD and `docs/`.
3. Python **3.12** venv for the pipeline (`/opt/homebrew/bin/python3.12`). The system default here is
   3.14, where GeoPandas/GDAL wheel availability is still patchy — not worth debugging on day one.
4. Scaffold `pipeline/` with the `dpt` CLI skeleton and `pyproject.toml`.
5. Data-source + licensing register (`04-DATA-REGISTER.md`), traffic explicitly marked **unresolved**.
6. **Spike-0** (see `06-SPIKE-0.md`) — the OSM audit, GTFS check, bake-off, alignment proof.
7. Recruit 5 target users; write the one-page research plan. Run these interviews *in parallel* with
   the spike — they are the only genuinely parallelisable work in a solo project.
8. Lock `config/study-area.json`: `PROPOSED` → `LOCKED`, derived origin filled, routes selected.
9. `brew install uv`, install the blender-mcp add-on, verify against Blender 5.2. **Non-blocking** —
   if it fails, note the failure and continue; the bake does not need it.
10. Prototype the bus-frequency calculation in a notebook against the real GTFS snapshot, before any
    of it becomes TypeScript.

Only after (8) does Phase 1 start.

## Four problems with the PRD as written

Stated plainly, with a proposed resolution each. None of them change the scope.

**1. The schedule does not add up.** The phase durations sum to **15–16 weeks**; the stated target
window is **10–12 weeks part-time**. Proposed resolution: do not pick now. Track velocity through
Phase 1 and decide at the Phase 1 exit gate, when there is evidence. The cut list that gets it to
~12 weeks, in the order it should be applied:
   - drop FR-04 (landmark/corridor search, P1 — and absent from the MVP acceptance criteria); the
     named viewpoints in FR-02 cover orientation
   - 5 landmarks → 3 (`config/study-area.json` already treats 2 as optional)
   - compress Phase 5 to one week: keep the 5-user moderated test (the success metrics depend on it),
     cut the demo-video production
   - defer post-processing (SSAO, colour grading) entirely — it is the definition of polish

**2. FR-15 is mis-prioritised.** Export is marked **P1**, but MVP acceptance criterion #8 —
"Exports contain scope, time, data sources and assumptions" — cannot pass without it. Proposed
resolution: **treat FR-15 as P0.** A minimal version (canvas screenshot + a JSON/text summary block)
is roughly a day's work, and it is the single feature that makes the product's honesty survive
outside the app.

**3. "Blender → glTF/GLB" is too broad a reading.** Roads must be **runtime** geometry, not baked
assets: corridor colour *is* the analytical data and changes with time, traffic and scenario. Baking
roads into GLB would freeze the layer the whole product exists to show. Resolution and the full
what-is-baked-where split: `03-BLENDER-PIPELINE.md`.

**4. 8 GB of unified memory is the binding constraint, and the PRD does not mention it.** This M1 is
close to the PRD's own "ordinary integrated-GPU laptop" target, which is good news — it is the right
benchmark device. But it means headed Blender and the web app cannot be open at once during
benchmarking, and it is the reason the asset pipeline runs headless.

## The Blender answer, in short

**Headless is the pipeline of record; headed + MCP is a bounded authoring cockpit for the 3–5 hero
landmarks.** `blender-mcp` is an add-on that opens a socket inside a *running GUI* Blender, so
"headless MCP" does not exist — the real choice is scripted CLI versus MCP driving a live session.
Verified on this machine: headless Blender 5.2 exports GLB **with Draco** out of the box and renders
offscreen with Workbench (0.9 s), EEVEE (4.5 s) and Cycles (0.6 s) at 480×320. That last fact is
decisive — headless has a closed visual QA loop, so it is not blind, and the usual reason to want a
GUI evaporates for everything except creative shaping.

## Definition of done for V1

The PRD's §17 checklist, plus two additions this plan introduces:

- `make budget` passes — no asset or transfer budget exceeded, enforced in CI, not by inspection
- deleting any file from `web/public/data/@v1/` still loads the app and reports the gap accurately
