# 06c — Spike-0 bake-off and alignment proof

Run 3 September 2026 · Blender 5.2.0 LTS · Apple M1 / 8 GB.

## 4. The bake-off — and it reverses ADR-003

Both paths were built for real, not estimated.

| | **A · Baked GLB** | **B · Runtime extrusion** |
|---|---|---|
| What ships | `buildings.glb`, Draco, 2 primitives | `buildings.json`, footprint rings + heights |
| Raw | 274.5 KB | 592.8 KB |
| **Transfer (gzip)** | **266.0 KB** | **175.3 KB** |
| Geometry | 3,203 footprints → 46 k verts, 60,914 tris | identical, built in the browser |
| Cost at load | Draco WASM decode | extrude 3,203 polygons in JS |
| Build time | 0.6 s headless | n/a |
| Draco ratio | 12.0× vs uncompressed GLB (3.38 MB) | n/a |

Two things settle it, and neither was obvious before measuring:

1. **Draco output barely gzips** — 274.5 KB raw compresses to 266.0 KB, because Draco is already
   entropy-coded. The footprint JSON, being ordinary text, goes 592.8 → 175.3 KB.
2. **`buildings.json` has to ship anyway.** FR-10 requires every entity to be inspectable: id, name,
   class, height and *height mode* per building. So path A's real cost is GLB **plus** JSON —
   441 KB — against path B's 175 KB. Path B is 2.5× lighter.

A mesh is a *generated artefact* of its footprint. Shipping both the generator and the generated
thing was the mistake hiding inside the original plan.

> ### Decision: ordinary buildings are extruded at runtime. Blender's scope narrows to hero landmarks.
>
> This is the reversal **ADR-002 and ADR-003 pre-declared** — "reverses if the bake-off shows baked
> tiles blow the budget, then Blender narrows to landmarks only". The trigger fired, so the decision
> was cheap. That is the whole point of running the spike before visual production.

Runtime extrusion also buys something the bake cannot: the geometry can be **rebuilt when the height
rule changes**, so a "show me which heights are guessed" toggle is a re-extrude rather than a second
downloaded asset. With 91.8% of this box carrying an estimated height, that toggle is a trust
feature, not a nicety.

What survives from the bake pipeline: `blender/scripts/lib/dptblend.py` and the headless invocation
contract are unchanged and now serve `20_landmark_export.py`. The bake script stays in the repo as
the measured alternative — deleting it would delete the evidence.

## 5. Alignment proof

- **Axis round-trip: PASS.** The exported GLB was re-imported and measured: extent
  X 3,989 m · Y 4,306 m · height axis 17.6 m. Height lands on the correct axis, so `export_yup=True`
  with no manual rotation is confirmed as the right combination. This check now lives in
  `dptblend.assert_yup()` and runs on every export.
- **Clip bounds: PASS.** Roads and ground clip to exactly ±1967.5 × ±2043.2 m.

### Two bugs the proof caught

**Origin at the SW corner put every Z coordinate negative.** Correct per the stated axis mapping, but
it meant the scene occupied z ∈ [−4086, 0] while the config claimed 0…4086. Origin moved to the
**box centre** (UTM 43N 716843.49 E, 3168119.03 N): coordinates are now symmetric at about ±2000 m,
the camera orbits the true origin, and float32 headroom is maximised.

**Overpass returns complete ways, so geometry spilled up to 760 m outside the locked bounds.** The
box was "locked" while roads ran 760 m west of it. Now: lines and large polygons are cut at the
boundary; buildings are kept or dropped whole by centroid, since they are small enough that no seam
shows — except a handful of large station canopies, which are clipped at a 30 m tolerance. 102
buildings dropped as outside.

Neither bug was visible in any count-based audit. Both would have been baked into every downstream
asset.

## Final measured data budget

| Asset | gzip | Layer |
|---|---|---|
| `buildings.json` | 175.3 KB | 3,203 footprints + heights + modes |
| `roads.json` | 31.5 KB | main-class + named minor centrelines |
| `ground.json` | 32.1 KB | landuse/leisure — the layer that carries this city |
| `rail.json` | 6.1 KB | metro/rail lines + 14 stations |
| `transit.json` | 5.3 KB | 171 stops + 3 selected DTC routes |
| `corridors.json` | 2.2 KB | 3 hero spines, segmented at ~150 m |
| `manifest.json` | 2.8 KB | versions, provenance, budgets, health |
| `water.json` + `weather` + `scenario-model` | 4.1 KB | |
| **Total** | **≈ 260 KB** | against a 6 MB target and a 15 MB hard gate |

The entire city ships in about a quarter of a megabyte. The transfer budget is a non-issue; the
remaining performance question is draw calls and frame time, which the web build addresses next.
