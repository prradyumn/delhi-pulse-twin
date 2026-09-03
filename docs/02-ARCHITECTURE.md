# 02 — Architecture

## The decision that shapes everything: no backend in V1

The scope lock says the MVP must launch from bundled, versioned data with no live provider required.
The cleanest way to *guarantee* that is to have nowhere for a live dependency to hide. So the PRD's
§9 endpoint table becomes **versioned static files served from the CDN**, and the scenario engine runs
**client-side in TypeScript**.

| PRD endpoint | V1 realisation |
|---|---|
| `GET /manifest` | `/data/@v1/manifest.json` |
| `GET /tiles/{z}/{x}/{y}` | `/data/@v1/tiles/buildings/{tx}_{ty}_lod{n}.glb` (fixed 4×4 grid, no zoom pyramid) |
| `GET /transit/routes` | `/data/@v1/transit/routes.json`, `stops.json` |
| `GET /transit/vehicles` | `/data/@v1/transit/vehicle-replay.json` — deterministic, `mode: "replay"` |
| `GET /weather` | `/data/@v1/weather/baseline.json`; optional Open-Meteo adapter overlays it |
| `POST /scenarios` | `runScenario()` in TS — pure, deterministic, versioned formula |
| `GET /entities/{id}` | `/data/@v1/entities/index.json` + chunked records |

Consequences worth being explicit about:

- **Open-Meteo needs no API key**, so it can be called directly from the client behind an adapter
  interface, with attribution. No secret, no server.
- **TomTom needs a key**, and the NFR says secrets stay server-side. That forces a serverless proxy,
  which is exactly why traffic stays bundled in V1 and TomTom waits for V1.5. The PRD already reaches
  this conclusion; this is the mechanical reason.
- A scenario is reproducible from `{dataset_version, transform_version, formula_version, params}`.
  That tuple goes into every export, which is what makes the export honest outside the app.

## Repository layout

    delhi-pulse-twin/
      CLAUDE.md
      Makefile                     # the commands in CLAUDE.md
      config/study-area.json       # THE scope lock — bbox, CRS, origin, corridors, tiles, budgets
      docs/
      snapshots/v1/                # pinned inputs + checksums + provenance.json (committed)
      pipeline/                    # Python 3.12, uv-managed
        pyproject.toml
        src/dpt/
          acquire/    osm_extract.py  gtfs_snapshot.py  weather_snapshot.py
          validate/   schema.py  checks.py
          normalize/  entities.py  project.py            # pyproj, local origin
          transform/  tiles.py  heights.py  corridors.py  replay.py
          provenance.py
          cli.py                                          # typer: dpt acquire|validate|...|snapshot
        tests/
      blender/                     # see docs/03-BLENDER-PIPELINE.md
        scripts/{lib,10_build_tiles.py,20_landmark_export.py,30_qa_render.py}
        landmarks/*.blend
      web/                         # Vite + TypeScript + Three.js
        src/
          core/      renderer.ts  camera.ts  loop.ts  capability.ts  perfHud.ts
          geo/       projection.ts  origin.ts  tileMath.ts
          layers/    buildings.ts  roads.ts  water.ts  rail.ts  transit.ts  weather.ts
          data/      manifest.ts  loader.ts  snapshot.ts  adapters/{openMeteo,tomtom}.ts
          time/      clock.ts  playback.ts  freshness.ts
          scenario/  engine.ts  busFrequency.ts  rainfallStress.ts  compare.ts  metrics.ts
          ui/        layerRail  legend  detailDrawer  scenarioLab  dataStatus  exportPanel
          story/     steps.ts
          telemetry/ events.ts
        public/data/@v1/           # pipeline + Blender output (generated, not hand-edited)

`web/public/data/@v1/` is generated. `snapshots/v1/` is the committed pinned input. That separation is
what makes "re-run the pipeline and get the same city" checkable.

## Layer independence (FR-01)

"Missing layers fail independently" is an architectural requirement, not error handling bolted on
later. Each layer is registered with `{id, load(), mount(), unmount(), status}` and the scene builds
from whichever layers resolve. One rejected fetch degrades its own layer to an explicit
`unavailable` state in the legend and data-status panel; it cannot reject the scene. Test this by
deleting files from `public/data/@v1/` and asserting the app still loads and says what is missing.

## Data mode is a first-class type

    type DataMode = "observed" | "estimated" | "simulated" | "replay";
    type Provenance = {
      provider: string; dataset: string; license: string; attribution: string;
      retrieved_at: string; source_time: string | null; refresh_cadence: string | null;
      bounds: BBox; crs: string; mode: DataMode;
      transform_version: string; limitations: string[];
    };

Nothing analytical renders without a `Provenance`. The type system enforces the PRD's honesty
principle: a layer with no provenance record does not compile.

## Scenario engine v0.1 — transparent by construction

Weights and penalty tables live in `/data/@v1/scenario-model-0.1.json`, are loaded at runtime, and are
**displayed in the UI**. Changing a weight is a data change with a version bump, not a code edit.

**Bus frequency.** Baseline headway `h0` from GTFS weekday trips/hour on the route inside the bbox.
Scenario headway `h1 = h0 · (f0/f1)`. Wait-time proxy `w = h/2` (evenly spaced arrivals — labelled a
proxy, invalid for irregular arrivals). Outputs: `Δw`, buses/hour `= 60/h`, stops served in-box.

**Rainfall stress.** Speed multiplier by road class × IMD rain band
(none / light <2.5 / moderate 2.5–7.6 / heavy 7.6–35 / very heavy >35 mm·h⁻¹), from the declared
penalty table. Travel-time index proxy `= Σ(len/v_scenario) / Σ(len/v_baseline)` over corridor
segments. No claim of physical flood modelling.

**Mobility Stress Index.** `MSI = w₁·speedPenalty + w₂·transitPressure + w₃·weatherImpact`, each term
normalised to 0–1, weights `0.45 / 0.30 / 0.25` at v0.1, shown on screen next to the value.

Every scenario function is pure `(baseline, params, model) => result`, which makes `Reset` exact by
definition — it re-reads the baseline snapshot rather than trying to undo state.

## Prior art to reuse

`~/ConveGenius_3D` is an existing Vite + Three.js project with `tools/optimize_assets.mjs` and
`authoring/tools/inspect_glb.mjs`. Read those before writing the budget gate and GLB inspector —
they are probably 80% of `make budget`.
