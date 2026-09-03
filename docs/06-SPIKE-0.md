# 06 — Spike-0: the gate before any visual production

**Duration: 2 days. Nothing in Phase 1 starts until this passes.** The PRD is explicit that the
technical spike precedes visual production, and it names the two unknowns that can sink the project:
OSM completeness and 3D performance. This spike answers both with numbers.

## Deliverables

### 1. OSM completeness audit — 3 candidate bboxes
For each candidate (the proposed box, plus one shifted north to include New Delhi Railway Station,
plus one shifted east toward Purana Qila), report:

- building footprint count, and **% with a real `height` or `building:levels` tag** (this drives how
  much of the city is honestly "estimated")
- highway segment count by class; whether all three corridors are continuous and correctly named
- water / rail / metro presence
- landmark footprints present and plausibly shaped
- **is there a usable diversion path** between the corridor endpoints using the wider road graph?
  This is what decides whether the V1.5 closure scenario is viable — record it now, promise it later

**Pass:** one candidate has continuous named geometry for three corridors and ≥3 usable landmark
footprints. Height tag coverage is *recorded, not gated* — low coverage is fine, it just has to be
disclosed as estimated.

### 2. GTFS reality check
From the pinned Delhi GTFS static: count routes with ≥5 stops inside the box, and weekday trips for
the top candidates. **Pass:** ≥3 qualifying routes, at least one touching each corridor.
Note that OTD warns static stop times are constant-speed estimates — confirm this in writing, because
it is the reason replay must be labelled `replay`, not `observed`.

### 3. The bake-off — one tile, measured both ways
Take the densest 1 km tile. Produce it twice:

- **A. Baked**: headless Blender extrusion → merged mesh → GLB + Draco
- **B. Runtime**: quantised footprint GeoJSON → `ExtrudeGeometry` in a Web Worker

Measure for each: **transfer bytes (gzip/br), decode-or-extrude ms, triangles, draw calls, JS heap
delta, steady-state FPS** in the default camera view on the M1/8 GB with Chrome and nothing else
running.

**Pass:** at least one path lands ≤900 KB and holds ≥30 FPS. Extrapolate to 16 tiles and check the
12 MB target. **Whichever wins, wins** — this is the decision that sets Blender's real scope for the
rest of the project, and it gets made on measurements.

### 4. Alignment proof
Render the baked tile in Three.js with the road ribbons from the same transform on top. Confirm no
visible systematic offset at all three corridors, and that the axis round-trip is correct (+Y up).
This is the single check that catches a broken CRS chain before it is baked into 16 tiles.

### 5. Committed outputs
`config/study-area.json` with `status` flipped from `PROPOSED` to `LOCKED`, the derived
`local_origin_utm` filled in, and `bus_routes.selected` populated. Plus `docs/06-SPIKE-0-RESULTS.md`
with the measured table.

## No-go responses (pre-agreed, so the decision is cheap)

| Finding | Response |
|---|---|
| No candidate box has three clean corridors | Drop to two corridors — do **not** grow the box |
| Both bake and runtime paths blow the budget | Shrink to a 3×3 km box before reducing visual quality |
| <3 qualifying bus routes | Ship 2 routes; bus-frequency scenario still works on one |
| Corridor geometry broken in OSM | Fix upstream in OSM (it is a public good) or swap to `sansad-marg` |

## Why this ordering

The expensive, irreversible work is the 16-tile bake and the landmark sprint. Both depend on bounds
and on the bake-vs-runtime answer. Two days spent here protects roughly six weeks downstream, which
is also the strongest single item in the eventual case study: a spike that changed a decision.
