# Delhi Pulse Twin

A browser-based mobility and city-scenario explorer for one locked 4 × 4 km box of Central Delhi —
Connaught Place to India Gate. Built from bundled, versioned data: **no live provider is required,
and disabling every external API cannot break the demo.**

Product requirements: `Delhi_Urban_Digital_Twin_PRD_v1 (1).docx` (v1.1, scope-locked).
How it is being built: `docs/` — start at [`docs/00-PLAN.md`](docs/00-PLAN.md).

## Status

**Phase 0 complete.** Spike-0 ran, the bounds are locked, the pipeline produces the full dataset,
and the web application is written. See [`docs/06-SPIKE-0-RESULTS.md`](docs/06-SPIKE-0-RESULTS.md)
and [`docs/06-SPIKE-0-BAKEOFF.md`](docs/06-SPIKE-0-BAKEOFF.md) for the measurements.

| | |
|---|---|
| Study box | `77.1975, 28.6039 → 77.2385, 28.6401` · 3,935 × 4,086 m · **LOCKED** |
| Projection | EPSG:32643 (UTM 43N), local origin at the box centre `716843.49 E, 3168119.03 N` |
| Corridors | Baba Kharak Singh Marg (75 bus routes) · Barakhamba Road (15) · Kartavya Path (0, by nature) |
| Buildings | 3,203 footprints, **8.2%** with a measured height — the rest estimated by rule v0.1 |
| Transit | 171 stops, 3 routes selected from 210 OSM DTC route relations |
| Whole dataset | **≈ 260 KB gzip** against a 6 MB target and a 15 MB hard gate |

### What is verified vs. what is not

Verified by running it: the OSM audit across three candidate boxes, the deep density/height audit,
the corridor bus-coverage scoring, the full pipeline build, the headless Blender bake, Draco
compression, the axis round-trip, and the clip bounds.

**Not yet verified: the web application has never been run.** It is written but untypechecked and
unrendered — see *Known blocker* below. Expect a first pass of compile and render fixes.

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

Landmarks need one extra fetch first, because India Gate is tagged `historic=monument` rather than
`building` and the relation-backed footprints need stitching:

    python3 pipeline/fetch_landmarks.py && make data && make assets

## Known blocker — a wedged shell

Renaming the original project directory (its name ended in a space, which breaks npm scripts,
Blender `--python` argv and Vercel) left the session's working directory pointing at a path that is
now **a file, not a directory**. Every shell spawn fails with `ENOTDIR … posix_spawn '/bin/zsh'`,
so nothing could be run after that point.

To clear it, from any terminal — this cannot be done from inside the wedged session, because the
only tool that can remove a file is the shell that will not start:

    bash /Users/pradyumnawasthi/delhi-pulse-twin/unwedge.sh

The script inspects before it removes, refuses to delete anything non-empty (pass `--force` only
after looking at what it found), recreates the old path as an empty directory so any shell still
holding that working directory can spawn again, and verifies the result. Then:

    cd /Users/pradyumnawasthi/delhi-pulse-twin && make check

### Before the first run, landmarks need one fetch

`landmarks.json` is not generated yet, so the landmark layer will report `unavailable` — which is
the correct independent-failure behaviour, not a crash. To populate it:

    python3 pipeline/fetch_landmarks.py && make data && make assets

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
