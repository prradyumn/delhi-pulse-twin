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
