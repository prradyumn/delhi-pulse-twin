# Delhi Pulse Twin — working rules

Browser-based mobility & city-scenario explorer for a fixed ~4x4 km Central Delhi box.
Source of truth for *what* to build: `Delhi_Urban_Digital_Twin_PRD_v1 (1).docx` (PRD v1.1, scope-locked).
Source of truth for *how*: `docs/`. Read `docs/00-PLAN.md` first.

## Non-negotiables (from the PRD scope lock)
1. **The demo must run with every external API disabled.** Bundled, versioned snapshot data is the
   launch path. Live adapters are progressive enhancement and must never be on the critical path.
2. **Never label estimated/replayed data as live.** Every time-dependent layer carries
   `mode` ∈ {observed, estimated, simulated, replay}, `source_time`, `retrieved_at`.
3. **No predictive wording.** Scenario copy uses "estimated" / "may" / "under these assumptions".
   Never "will".
4. **Geometry comes from geographic data**, never hand-drawn. WGS84 -> EPSG:32643 -> minus local
   origin -> Three.js. One transform, one origin, defined in `config/study-area.json`.
5. **The bounding box and the three corridors are frozen** until every P0 acceptance criterion
   passes. New geography is a later release.
6. **Performance is a gate, not a wish.** A visual effect is accepted only after the default scene
   still meets the load / FPS / transfer budgets in `docs/01-SCOPE-LOCK.md`.
7. **Every dataset carries a provenance record** and an entry in `docs/04-DATA-REGISTER.md` before
   it is allowed into the build.

## Blender
Headless CLI (`blender --background --factory-startup --python`) is the **pipeline of record**.
Headed Blender + blender-mcp is an authoring cockpit for the 3-5 hero landmarks only, and every
headed session must end by committing a `.blend` plus a deterministic export script.
Nothing ships that exists only inside a live Blender session. See `docs/03-BLENDER-PIPELINE.md`.

## Hardware reality (drives several decisions)
Apple M1, 8 GB unified memory. This machine is close to the PRD's "ordinary integrated-GPU laptop"
target, so it is the primary benchmark device. Do not run headed Blender while benchmarking the web
app — memory pressure invalidates the numbers.

## Commands
    make spike        # Spike-0 gate: OSM audit + one baked tile + FPS/transfer measurement
    make data         # pipeline: acquire -> validate -> normalize -> transform -> snapshot
    make assets       # headless Blender: bake building tiles + landmark LODs -> GLB
    make qa-render    # headless contact-sheet renders for visual review
    make dev          # web app dev server
    make budget       # fail the build if any asset/transfer budget is exceeded
