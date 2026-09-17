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
| Buildings | 3,196 footprints — 261 heights from an OSM tag, 2,564 read from a satellite raster, **11.6%** still estimated by class rule v0.2 |
| Transit | 166 stops, 3 routes selected from 210 OSM DTC route relations |
| Landmarks | 8 verified footprints; 6 built parametrically from their own OSM footprint, 2 open ground; 18 GLB LODs, all budget-gated |
| Live | Open-Meteo air quality + weather (keyless); Delhi OTD GTFS-Realtime vehicle positions behind a server-side key |
| Measured | **60 fps · 2.1 ms/frame · 151 draw calls · 937,419 triangles · 0.91 MB gzip initial transfer** (gate: 15 MB) |
| Tests | 161 data invariants · 87 browser checks; FR-01 independent-failure confirmed by deleting layer files |

Verified by running: the OSM audit across three candidate boxes, the density and height audit,
corridor bus-coverage scoring, the pipeline, the Blender bake and landmark export, Draco, the axis
round-trip, clip bounds, the QA contact sheets, both scenarios end to end, all ten guided-story
steps, click-to-inspect provenance, export contents, and the budget gate.

**Still to do:** the 5-user moderated test, and the schedule decision deferred to the Phase 1 gate.
The landmark sprint is done as scripts rather than a headed Blender session — see
[`docs/07-RENDER-CORRECTNESS.md`](docs/07-RENDER-CORRECTNESS.md) part five for why a parametric
build was the better artefact for forms this regular, and for what these models do *not* claim.

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
    make check      # data + typecheck + build + budget gate + 90 browser checks
    make reel       # record the demo reel (needs a build; ~90 s)

`make data` also fetches the landmark footprints, which need their own query: India Gate is tagged
`historic=monument` rather than `building`, and the relation-backed footprints need stitching.

From nothing to a running city:

    make setup && make data && make assets && make check && make dev

## Showing it

The demo runs from bundled data and cannot be broken by a dead network. The live feeds are an
upgrade on top of that, and they are worth having on, because they are what makes the air-quality
panel a measurement rather than a pinned number.

**Before you present**, on the machine that will be presenting:

    set -a; . ./.env.local; set +a     # the pipeline is a separate process; it needs the key exported
    make check                         # data -> build -> budget gate -> 87 browser checks
    make dev                           # serve it — this is the server that proxies the bus feed

`make check` runs the whole gate: it regenerates `web/public/data/@v1/` (which is **not** in git),
typechecks, builds, fails on any breached budget, and then drives the built app in headless Chrome
through both scenarios, the selection drawer, the live-bus decoder and all ten story steps.

Only the Python pipeline needs the key exported by hand — Vite is pointed at the repo root with
`envDir`, so `make dev` and `make preview` pick up `.env.local` on their own.

`make data` must run **with the key in the environment**: the manifest is the authority on which
providers the app may contact, and a build made without the key permits no live buses, whatever is
in `.env.local` at run time. `make dev` (or `make preview`) is required for live buses too — a bare
static server has no `/api/vehicles`, and the key must never reach the browser.

**What will be live**, and what to say about each:

| | |
|---|---|
| Air quality | Live, keyless, and the strongest thing here. PM2.5 against the WHO guideline, plus *why* — mixing-layer depth, ventilation index, fine fraction. Modelled at ~11 km, so it explains the region, not the street, and the panel says so. |
| Live buses | Real DTC positions. Expect **about two inside the box** in daylight and **zero at night** — 1,300+ buses are moving across Delhi and this box is 16 km² of it. The chip distinguishes all three states and replay keeps running underneath. |
| Everything else | Bundled. Pull the network cable and the demo still completes. |

**If you need it on a slide rather than live**, `make reel` records an 80-second tour through the
real UI — the opening claims, the height-provenance reveal, one building's own story, the live air
panel, India Gate, the Kartavya Path axis, and dusk over Connaught Place. It drives the actual
controls, so it cannot show anything a viewer could not reproduce. Output lands in
`spike/results/reel/` as both `.webm` and `.mp4`; the recording is gitignored because it is 36 MB a
take and the script is the reproducible thing.

**A five-minute path**, if you want one that is already sequenced: click *Take the 4-minute guided
story* on the opening card. Ten steps, ending at India Gate at dusk. It sets the camera, clock,
corridor and scenario for each step, so nothing has to be driven by hand.

**If you want to drive it yourself**, the four things worth showing, in order:

1. **Click any building.** The drawer names the height, whether it was measured or assigned, and by
   which rule — then the provider, licence, retrieval date and CRS underneath. This is the product's
   argument in one click.
2. **Scenario Lab → Baba Kharak Singh Marg → Bus frequency 2×** → *Run scenario*. Then switch to
   **Kartavya Path** and watch the scenario disable itself and say why.
3. **Air & exposure.** The dose split by mode, and the finding that on a bus journey the *waiting*
   is about half the inhaled dose — which makes bus frequency an air-quality lever.
4. **Reach → Can a cleaner route help?** The measured answer is usually *no*, and the panel says so
   with the number. A tool that reports a null result is doing the harder thing.

**If something looks wrong on the night:** every layer fails independently and reports its own
status in the left rail — a missing data file degrades that layer and nothing else (`make qa`
proves this by deleting two of them). *Data status* in the masthead lists every layer, its mode and
its provenance. Nothing needs to be restarted to recover a failed live feed; it re-polls.

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

## Deploying

Vercel, from the repo root. The layout is what Vercel requires, not a preference:

    api/vehicles.ts        the live-bus proxy — Vercel ONLY discovers functions in api/ at the
                           project root, and it declares its own edge runtime
    web/                   the Vite app; built by `cd web && npm ci && npm run build`
    web/public/data/@v1/   the 5.8 MB bundled dataset, committed because it IS the product and
                           cannot be rebuilt in a Vercel build (no Python, no 159 MB of raw OSM)
    vercel.json            build command, output directory, cache headers
    .vercelignore          the pipeline, Blender stage, spike inputs and docs, none of which are
                           read at build or request time

`vercel.json` sets `additionalProperties: false`, so it cannot carry comments — not even
`_`-prefixed ones. One unknown key rejects the whole file and fails the deployment *before the
build starts*: a 0 ms build, status Error, nothing in the logs. This file carried a `_note` key
from the day it was written, which is why the project had never once deployed successfully. So the
reasons live here instead:

- **`api/vehicles.ts` is at the repo root, not in `web/`.** Vercel only discovers functions under
  `api/` or `pages/api/` at the project root. A `functions` glob pointing anywhere else is the
  documented "Incorrect Function Glob Pattern" error, and the function is simply never built.
- **The function declares its own runtime** (`export const config = { runtime: "edge" }`), so it
  needs no entry in `vercel.json`.
- **`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is inline in the install command.** `playwright` is a
  devDependency for `tools/reel.mjs`, and `npm ci` would otherwise run its postinstall and pull
  ~150 MB of browsers into every build. It cannot simply be omitted with `--omit=dev`, because
  vite and typescript are devDependencies too. Setting it inline rather than in `build.env` is
  deliberate: that key is deprecated, and inline provably applies to the install step.
- **Cache headers are split by mutability.** `/assets/` is content-hashed by Vite, so it is
  immutable for a year. `/data/` is rewritten in place by `make data`, so it gets five minutes and
  stale-while-revalidate.

`make check` validates all of this offline — `web/tools/vercel-check.mjs` fails the build on an
unknown key or a missing function, so the file cannot silently stop deploying again.

One environment variable, and it is optional:

| | |
|---|---|
| `OTD_API_KEY` | Delhi Open Transit Data, for live bus positions. Without it `/api/vehicles` answers 200 with an `unconfigured` body, the layer rail reports it, and the app runs on deterministic replay — the scope-locked default. |

Verify a deployment in three checks: the page loads and the layer rail shows 19 of 20 layers ready;
`/api/vehicles` returns protobuf rather than JSON; and the masthead chip says how many live buses
are inside the box. `npx vercel build` reproduces the whole thing locally and will tell you if the
function stopped being discovered.

## Attribution

Base geography, buildings, roads, rail and bus routes: © OpenStreetMap contributors, ODbL 1.0.
Bus route relations carry operator Delhi Transport Corporation. Building heights from Google Open
Buildings 2.5D. Air quality and weather from Open-Meteo / Copernicus CAMS. Live vehicle positions
from Delhi Open Transit Data (GTFS-Realtime). The **static** OTD GTFS files are still not used —
they carry no `shapes.txt`, so no route geometry; see `docs/04-DATA-REGISTER.md` (D3, D5).
