# Delhi Pulse Twin

A browser-based mobility and city-scenario explorer for one locked 4 × 4 km box of Central Delhi —
Connaught Place to India Gate. Built from bundled, versioned data: **no live provider is required,
and disabling every external API cannot break the demo.**

Product requirements: `Delhi_Urban_Digital_Twin_PRD_v1 (1).docx` (v1.1, scope-locked).
How it is being built: `docs/` — start at [`docs/00-PLAN.md`](docs/00-PLAN.md).

## Status

**Phase 0 complete and the app runs.** Spike-0 measured the bounds and forced three scope changes,
the pipeline produces the full dataset, and the web application is verified end to end on the
primary benchmark device. See [`docs/06-SPIKE-0-RESULTS.md`](docs/06-SPIKE-0-RESULTS.md),
[`docs/06-SPIKE-0-BAKEOFF.md`](docs/06-SPIKE-0-BAKEOFF.md) and
[`docs/07-RENDER-CORRECTNESS.md`](docs/07-RENDER-CORRECTNESS.md).

| | |
|---|---|
| Study box | `77.1975, 28.6039 → 77.2385, 28.6401` · 3,935 × 4,086 m · **LOCKED** |
| Projection | EPSG:32643 (UTM 43N), local origin at the box centre `716843.49 E, 3168119.03 N` |
| Corridors | Baba Kharak Singh Marg (75 bus routes) · Barakhamba Road (15) · Kartavya Path (0, by nature) |
| Buildings | 3,203 footprints, **8.2%** with a measured height — the rest estimated by rule v0.1 |
| Transit | 166 stops, 3 routes selected from 210 OSM DTC route relations |
| Landmarks | 8 verified footprints; 6 massing, 2 open ground; 18 GLB LODs, all budget-gated |
| Measured | **60 fps · 14 draw calls · 80,663 triangles · 0.71 MB gzip** (gate: 15 MB) |
| Tests | 90/90 data invariants; FR-01 independent-failure confirmed by deleting layer files |

Verified by running: the OSM audit across three candidate boxes, the density and height audit,
corridor bus-coverage scoring, the pipeline, the Blender bake and landmark export, Draco, the axis
round-trip, clip bounds, the QA contact sheets, both scenarios end to end, all ten guided-story
steps, click-to-inspect provenance, export contents, and the budget gate.

**Still to do:** the Phase 4 landmark modelling sprint (all 6 buildable landmarks are correctly
placed and scaled massing blocks today, not authored models), the 5-user moderated test, and the
schedule decision deferred to the Phase 1 gate.

## Layout

    config/study-area.json     the scope lock — bounds, CRS, origin, corridors, height rule, budgets
    docs/                      plan, architecture, decisions, data register, spike results
    spike/                     Spike-0 audit scripts and their measured results
    pipeline/                  Python 3.12: OSM extract -> versioned runtime data
    blender/                   headless asset stage — hero landmarks only, after the bake-off
    web/                       Vite + TypeScript + Three.js application
    snapshots/v1/              build reports and pinned provenance

## Commands

    make setup      # python 3.12 venv + web deps
    make spike      # re-run the Spike-0 audits (cached; delete spike/_raw to refetch)
    make data       # OSM extract -> web/public/data/@v1/
    make assets     # headless Blender: landmark LODs -> GLB, budget-gated
    make dev        # web app dev server
    make check      # data + typecheck + build + budget gate

`make data` also fetches the landmark footprints, which need their own query: India Gate is tagged
`historic=monument` rather than `building`, and the relation-backed footprints need stitching.

From nothing to a running city:

    make setup && make data && make assets && make check && make dev

## The two things this project is careful about

**Data mode is a type, not a caption.** `Provenance` is a required field on every layer, carrying
provider, licence, retrieval time, CRS, transform version and `mode` ∈ observed / estimated /
simulated / replay. A layer without one does not compile. The detail drawer shows all of it for
every entity you click.

**Scenarios cannot be mistaken for forecasts.** Weights live in
`data/@v1/scenario-model-0.1.json`, are loaded at runtime and are displayed next to the numbers they
produce. Reset re-reads the baseline rather than undoing state. No output says "will". Where a
corridor has no transit at all, the bus-frequency scenario disables itself and says why instead of
returning zero.

## Attribution

Base geography, buildings, roads, rail and bus routes: © OpenStreetMap contributors, ODbL 1.0.
Bus route relations carry operator Delhi Transport Corporation. Weather baseline authored for this
prototype. Delhi OTD GTFS is **not** used — see `docs/04-DATA-REGISTER.md` (D3, D5) for why.
