# 01 — Scope lock

The machine-readable copy is `config/study-area.json` and **that file is the authority**. This page
explains the choices; it does not duplicate the values.

## The box
A 4.01 × 4.00 km box centred on 28.6220 °N, 77.2180 °E — Connaught Place at the north edge, India
Gate and Kartavya Path across the south, Sansad Bhavan and Rashtrapati Bhavan's east face on the west
edge. Recognisable enough that a Delhi resident orients instantly, dense enough to make congestion
legible, small enough to optimise and validate. Status is `PROPOSED` until Spike-0 confirms it.

## The three corridors
Kartavya Path (E–W), Barakhamba Road (NE–SW), Janpath (N–S). Chosen for three things: three
genuinely different functional characters — ceremonial boulevard, dense commercial office corridor,
and the connector between them; all three touching or passing near Connaught Place, so bus routes
overlap them and one route selection can serve all three; and mutual connectivity — Janpath meets
Barakhamba Road at Connaught Place and crosses Kartavya Path in the south.

Note what is *not* true: **Barakhamba Road does not meet Kartavya Path directly.** These three do not
form a closed circuit on their own. Whether a closure has a usable diversion depends on the full road
graph inside the box, so Spike-0 must verify that on the real OSM graph before the V1.5 closure
scenario is promised to anyone. Alternate corridor: Sansad Marg.

## The landmarks
Three required — India Gate, Sansad Bhavan, and the Connaught Place inner circle as a stylised
colonnaded ring rather than one building. Together they anchor all three corridors. Two optional
(Rashtrapati Bhavan, Jantar Mantar) exist as the first thing to cut if Phase 4 runs long. Every
landmark is aligned to an OSM-verified footprint — never placed by eye.

## Tiles
A fixed 4 × 4 grid of 1 km tiles. Not a zoom pyramid: the camera never leaves the box, so a pyramid
would be machinery serving a use case that does not exist. 16 tiles × 2 LODs = 32 GLBs, which keeps
the per-tile budget arithmetic simple enough to check in your head.

## Budgets are gates
The numbers in `config/study-area.json` are enforced by `make budget`, which fails the build. The
sizing that has to hold: 16 tiles × 900 KB is already 14 MB, so the tiles alone would eat the entire
hard gate. Real target per tile is nearer 500 KB — which is plausible for simple prisms under Draco
(≈3,000 buildings/km² × ~12 vertices at ~12–16 bytes/vertex ≈ 0.5 MB) but is exactly what Spike-0's
bake-off measures. **If the measurement disagrees, the measurement wins.**

Primary benchmark device: this M1/8 GB laptop. It is close to the PRD's "ordinary integrated-GPU
laptop" target, so it is the right machine to gate on — with headed Blender closed.

## What unfreezing costs
Changing the box invalidates: the baked tiles, the landmark footprint alignment, the corridor metrics,
the GTFS route selection, and every benchmark number. That is roughly a week. It is why the box stays
frozen until every P0 acceptance criterion passes, and why Spike-0 exists.
