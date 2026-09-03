# 05 — Decision log

Append-only. Each entry: what was decided, why, and what would reverse it. This log is also the raw
material for the case study's "rejected options" section, so record the rejected option too.

## ADR-001 · No backend in V1 — static versioned files + client-side scenarios
**Accepted.** The scope lock demands the demo survive with every external API disabled. Removing the
server removes the place a live dependency could hide. `POST /scenarios` becomes a pure TS function
over a bundled baseline; reproducibility comes from `{dataset, transform, formula}` versions in every
export. *Rejected:* a small FastAPI service — real cost, no MVP benefit, and it invites live coupling.
*Reverses if:* TomTom enters scope (needs a key, so a serverless proxy) or scenarios outgrow the client.

## ADR-002 · Headless Blender is the pipeline of record; headed + MCP is a bounded landmark cockpit
**Accepted.** `blender-mcp` runs inside a live GUI Blender, so headless MCP does not exist. Headless
CLI is deterministic, CI-able, costs no GUI memory on an 8 GB machine, and — verified 2026-09-03 —
exports GLB+Draco and renders offscreen (EEVEE 4.5 s @480×320), so it has a closed visual QA loop.
MCP is kept for the one task that needs eyes on a viewport: 3–5 hero landmarks, ≤3 days, exiting to a
committed `.blend` plus a deterministic export script. Full reasoning: `03-BLENDER-PIPELINE.md`.
*Reverses if:* the bake-off shows baked tiles blow the budget (then Blender narrows to landmarks
only), or blender-mcp proves incompatible with 5.2 (then fallback A/B, critical path untouched).

## ADR-003 · Roads are runtime geometry, buildings are baked
**Accepted.** Corridor colour is the analytical payload and changes with time, traffic and scenario;
baking it would freeze the layer the product exists to show. Ordinary buildings are static and never
recoloured, so baking buys one draw call per tile and decode-instead-of-extrude on load.
*Reverses if:* Spike-0's bake-off favours runtime extrusion on transfer size.

## ADR-004 · EPSG:32643 (UTM 43N) with a committed local origin
**Accepted.** Well-supported everywhere in the toolchain. The ~1.0006 scale factor at 77.22 °E is
*uniform* and applied identically to every layer, so it cannot cause inter-layer misalignment — which
is the only accuracy criterion the PRD actually sets. Origin is derived once and committed, so the
transform is reproducible. *Rejected:* EPSG:7755 — more correct for national work, more friction here.

## ADR-005 · FR-15 (export) is treated as P0, not P1
**Accepted.** MVP acceptance criterion #8 depends on it, so its stated P1 priority is an internal
contradiction in the PRD. A minimal export is about a day and it is what keeps the product's honesty
intact once a screenshot leaves the app.

## ADR-006 · Python 3.12 for the pipeline, not the 3.14 default
**Accepted.** GeoPandas/GDAL wheel availability on 3.14 is not somewhere to spend day one.
*Reverses if:* the stack lands cleanly on 3.14 later; nothing depends on the version choice.

---

## Still open (PRD §16) — with the trigger that closes each

| Decision | Default | Closed by |
|---|---|---|
| Exact bbox coordinates | The proposed 4×4 km box in `config/study-area.json` | Spike-0 OSM audit + render benchmark |
| Bus routes | Top 3 by in-box stops × weekday trips | Spike-0 GTFS check |
| Live traffic (TomTom) | Deferred to V1.5 | Offline MVP complete, then licence/quota/cache review |
| Live weather (Open-Meteo) | Adapter behind the bundled state | Attribution + uptime check in Phase 2 |
| Primary persona | Planning student / junior analyst | Phase 0 interviews (5 users) |
| Scenario metric weights | v0.1 `0.45 / 0.30 / 0.25`, visible in UI | Domain review + sensitivity analysis in Phase 3 |
| Visual style | Geographically faithful, lightly stylised PBR | Phase 1 orientation feedback + FPS |
| 10–12 wk vs 15–16 wk schedule | Undecided on purpose | Phase 1 exit gate, using measured velocity |

## ADR-007 · Ordinary buildings extrude at runtime — ADR-003 reversed by measurement
**Accepted 2026-09-03, superseding the buildings half of ADR-003.** The bake-off measured baked
Draco GLB at 266 KB gzip against 175 KB for the footprint JSON — and the JSON ships regardless,
because FR-10 needs per-building id, name, class, height and height mode for inspection. Baking
meant shipping the generator *and* the generated mesh: 441 KB versus 175 KB. Runtime extrusion also
lets a "which heights are guessed?" toggle re-extrude instead of downloading a second asset, which
matters when 91.8% of the box has an estimated height. Roads, water, rail and buses were already
runtime, so **Blender's scope is now hero landmarks only** — exactly the narrowing ADR-002
pre-declared. *Reverses if:* footprint count grows by an order of magnitude, which it cannot while
the box stays locked.

## ADR-008 · pyproj + shapely, no GeoPandas
**Accepted.** The PRD suggested GeoPandas + GDAL. The pipeline needs projection, clipping,
simplification and line merging — all of which are pyproj and shapely directly. Skipping GeoPandas,
pandas, and a GDAL/Fiona stack removes the heaviest install in the project for no lost capability,
and the whole extract is only 6 MB so there is no dataframe-scale work to do. *Reverses if:* tabular
joins over attribute data become a real part of the pipeline.

## ADR-009 · Local origin at the box centre, not the SW corner
**Accepted after the alignment proof.** A corner origin put every Z coordinate negative and left the
scene at z ∈ [−4086, 0] while config claimed 0…4086. Centre origin gives symmetric ±2000 m
coordinates, a camera that orbits the true origin, and maximum float32 headroom.

## ADR-010 · Transit ships from OSM route relations, not GTFS
**Accepted.** Delhi OTD static GTFS sits behind a usage-declaration form and its file host was
unreachable on 2026-09-03; realtime returns 401 without an authorised key. OSM carries 210 bus route
relations / 138 distinct refs (operator DTC) touching the box — real route numbers and ordered stop
sequences, ODbL, already cleared under D1. Baseline headway becomes a **declared assumption**
(12 min) rather than an observation, and every derived metric is labelled a proxy. *Reverses if:* the
owner completes the OTD declaration, at which point GTFS supplies real scheduled headways as a V1.5
upgrade and the assumption disappears.
