# 04 — Data & licensing register

> **The gate:** no dataset enters the build until its row here is complete and `status` is `CLEARED`.
> Reachability is not permission. The PRD is blunt about this and it is the risk most likely to
> require throwing work away late.

Statuses: `UNVERIFIED` → `CLEARED` (terms read, attribution drafted, redistribution understood) →
`REJECTED` (with the reason kept, because rejections belong in the case study).

| # | Layer | Provider / dataset | Status | Access | Redistribution | Attribution text | Mode | Notes |
|---|---|---|---|---|---|---|---|---|
| D1 | Base geography, buildings, roads, water, rail | OpenStreetMap extract (Geofabrik or bounded Overpass, **preparation only**) | UNVERIFIED | open | ODbL — share-alike applies to derived data | drafted, must appear in-app | observed | Public Overpass must never be a runtime dependency |
| D2 | Building heights (where untagged) | Rule-based, derived in-house | n/a | n/a | ours | "estimated heights, rule v0.1" | **estimated** | Rule must be published in the UI; record real-tag coverage % from Spike-0 |
| D3 | Bus routes & stops | Delhi OTD GTFS **static** | UNVERIFIED | registration likely required | must confirm before shipping the file | required | observed (schedule) | OTD warns stop times are constant-speed estimates — this is why replay is `replay` |
| D4 | Bus vehicle movement | Derived deterministic replay from D3 | n/a | n/a | ours | "simulated replay from schedule" | **replay** | Must never be presented as live positions |
| D5 | Bus vehicle positions, live | Delhi OTD GTFS-Realtime | **BUILT, AWAITING KEY** | private key, authorised users only | not redistributed; proxied live | in-app | observed | Adapter, protobuf reader and edge proxy are written. Gated off in `live_adapters` until a key exists — see `docs/08-LIVE-DATA.md` |
| D6 | Metro lines & stations | OSM | UNVERIFIED | open | ODbL | required | observed (geometry) | Geographic context only. No live-train claim, ever |
| D7 | Weather baseline | Bundled snapshot, one pinned day | n/a | n/a | ours | timestamped | observed at snapshot time | The launch-critical weather path |
| D8 | Weather live | Open-Meteo | **CLEARED — IN USE** | no key needed | not redistributed; read live | in-app | observed | Direct from the client behind an adapter. Observed rain rate drives the rainfall control |
| D9 | Corridor traffic speeds | Bundled heuristic / replay, 3 corridors | n/a | n/a | ours | "estimated, heuristic v0.1" | **estimated** | The MVP traffic path. First-class, not a fallback |
| D10 | Traffic live | TomTom | UNVERIFIED | API key | caching may be restricted | required | observed | **Out of MVP** — the key forces a serverless proxy (NFR: secrets stay server-side) |
| D11 | Planning / land use | DDA GIS | UNVERIFIED | portal access ≠ bulk rights | unknown | required | observed | **Excluded from P0** by the PRD. Do not start |
| D12 | Landmark reference imagery | — | — | — | **do not redistribute** | — | — | Reference for modelling only. No photo texture ships. Acceptance criterion #9 |
| D14 | Air quality live | Open-Meteo Air Quality (Copernicus CAMS) | **CLEARED — IN USE** | no key needed | not redistributed; read live | in-app: "Air quality from Open-Meteo, based on Copernicus CAMS" | observed | The first live observed *measurement* in the product. ~11 km grid, so ONE value for the whole box — no spatial layer is possible and none is drawn |
| D13 | Elevation | — | — | — | — | — | — | Not required; the pilot presentation is flat |

## Provenance record — required fields on every dataset

`provider` · `dataset` · `license` + link · `attribution` · `retrieved_at` · `source_time` ·
`refresh_cadence` · `bounds` · `crs` · `mode` · `transform_version` · `limitations[]`

Emitted by `pipeline/src/dpt/provenance.py` into `snapshots/v1/provenance.json`, surfaced in the
detail drawer and in every export. Typed as `Provenance` in `web/src/data/` — see
`02-ARCHITECTURE.md`. A layer without one does not compile.

## Verify at implementation time, not now

The PRD's §19 links establish feasibility, not standing permission. Re-read each before integrating:
OTD documentation, OSM copyright/ODbL, Overpass usage policy, IMD API terms, DDA GIS, GTFS-RT
reference.

## The one thing to get right early

**D1's ODbL share-alike** shapes what can be published. Derived building tiles are a derived database.
Settle the attribution component and the licence statement in Phase 1, while it is a paragraph of
work — not in Phase 5, when it could invalidate a hosted demo.

---

# Building heights v0.2 — 91.8% guessed became 11.6%

## The problem, measured

Height rule v0.1 was a class-based guess (`commercial` → 5 storeys × 3.5 m, and so on) carrying
**91.8%** of the buildings in this box. It decides every skyline and every shadow in the render, so
it is worth knowing how wrong it is. Scored against the 241 footprints that hold a real OSM
`height` or `building:levels` tag:

| class | n | observed median | rule guess | error |
|---|---|---|---|---|
| apartments | 35 | 52.5 m | 14.0 m | **+38.5** |
| retail | 11 | 7.0 m | 14.0 m | −7.0 |
| commercial | 45 | 14.0 m | 17.5 m | −3.5 |
| office | 26 | 17.5 m | 17.5 m | 0.0 |

Most classes land within a storey. `apartments` is out by a factor of 3.75, because central Delhi's
apartment stock is high-rise blocks and the rule assumed a four-storey walk-up.

**Calibrating the rule on those 241 would have been the wrong fix.** Contributors tag tall and
notable buildings first, so that sample is selection-biased upward — its p90 is 45.5 m, which is
not central Delhi. Fitting to it bakes the bias in.

## The source

[Google Research Open Buildings 2.5D Temporal v1](https://sites.research.google/gr/open-buildings/temporal/):
per-pixel `building_height` from Sentinel-2, annual 2016–2023, ~4 m effective resolution, published
**mean absolute error 1.5 m**, licensed CC-BY 4.0 **and ODbL 1.0** — the same licence as the OSM
geometry it joins to.

**Fetched by HTTP range request.** Three source tiles overlap this box at 1.0–1.6 GB each: 3.7 GB to
answer a question about 16 km². They are internally tiled GeoTIFFs (512×512, DEFLATE, float32)
already in **EPSG:32643**, this project's own CRS, so `pipeline/fetch_building_heights.py` reads only
the 425 internal tiles the box touches — about 1% of the bytes, no Earth Engine account, and no GDAL
added to a pipeline that runs on pyproj and shapely alone (ADR-008).

Two format traps, both silent when you hit them:
- `PlanarConfig=2`, so `building_height` is tile indices 2401–4801, not an interleaved sample.
  Reading plane 0 returns fractional building *count* and looks entirely plausible.
- `Predictor=3`, the floating-point predictor: per row a cumulative byte sum, then an
  endian-dependent byte-plane de-shuffle. Skipping it yields noise; skipping only the de-shuffle
  yields numbers in roughly the right range, which is worse.

## Choosing the estimator, and why not by MAE

A footprint covers many pixels and the edge ones blend with the ground, so "the height" is a choice.
Five candidates were scored and **stratified by height band**, because the OSM sample's tall bias
means an overall MAE is dominated by towers.

Bias by band, in metres — the column that decided it:

| band | n | rule v0.1 | median | p75 | p90 |
|---|---|---|---|---|---|
| 0–8 m | 42 | **+3.6** | −1.1 | −0.1 | +0.9 |
| 8–15 m | 98 | +1.0 | **−0.1** | +1.8 | +2.9 |
| 15–25 m | 52 | **−5.6** | −3.0 | −1.6 | −0.7 |
| 25–45 m | 20 | **−18.7** | **−0.2** | +2.9 | +4.9 |
| 45 m+ | 29 | **−46.3** | −17.8 | −11.7 | −9.2 |

`median` of pixels above 1 m was chosen for **flattest bias**, not lowest MAE. In the 8–25 m band the
class rule actually has slightly lower scatter (MAE 3.3 vs 4.1 m) and the satellite is still
preferred: in a 3D city, systematic bias distorts the skyline and misplaces every shadow, while
scatter averages out over 3,000 buildings. A skyline flattened by 46 m is not redeemed by tidier
mid-rise noise.

## The confidence gate, and the render that forced it

Four footprints tagged `apartments` at exactly 91.0 m (26 levels × 3.5), clustered within 200 m,
came back from the raster as **zero — bare ground**. Their OSM way ids are all ~1.4–1.5 billion, so
they were mapped recently: towers built or still building after the 2023 imagery. Neither source is
wrong; they describe different years.

Without a gate the nearest thing to a reading (a 1.5 m median over 15% of the footprint) would have
been clamped to 2.5 m and shipped as the height of a 26-storey block. So a satellite height is
accepted only where the raster sees a building: **≥8 pixels, covering ≥35% of the footprint, at
≥3 m**. Otherwise the class rule is used and the reason recorded, which makes the disagreement
itself countable.

## Result

| | v0.1 | v0.2 |
|---|---|---|
| observed from an OSM tag | 261 (8.2%) | 261 (8.2%) |
| measured from satellite | — | **2,564 (80.2%)** |
| estimated by class rule | 2,935 (91.8%) | **371 (11.6%)** |
| MAE on the 234 checkable | 10.16 m | **6.47 m** |
| bias on the same | −7.31 m | **−2.64 m** |

Height provenance is now shown in the UI in **three** states, not two — collapsing a 1.5 m-MAE
measurement into the same bucket as an authored guess would discard the point of measuring it. An
OSM tag still outranks the satellite, because somebody standing in front of a finished building
beats a satellite that flew before it was built.

**Known limitation, measured not assumed:** above 45 m the satellite under-reads by 12–18 m —
Sentinel-2 derived heights saturate on towers. No correction is applied: the sample showing the bias
is 28 buildings, and fitting to that would be inventing precision.
