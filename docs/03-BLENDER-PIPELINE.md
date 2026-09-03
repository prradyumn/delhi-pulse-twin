# 03 — Blender pipeline: headless vs headed

## The decision

**Headless CLI is the pipeline of record. Headed Blender + blender-mcp is an authoring cockpit for
the 3–5 hero landmarks only.**

The question "headless MCP or headed MCP" has a factual answer that shapes everything else:

> `blender-mcp` is a Blender **add-on that opens a socket server (port 9876) inside a running GUI
> Blender instance**. The MCP server connects to that socket. There is no headless mode — you
> cannot start the add-on's server from `--background`. So the real choice is
> **scripted CLI (`--background --python`) vs. MCP driving a live GUI session.**

### Evidence gathered on this machine (2026-09-03, Blender 5.2.0 LTS, M1/8 GB)

| Probe | Result |
|---|---|
| `bpy.ops.export_scene.gltf` available in `--background` | yes |
| Draco compression in headless export | yes — `libbf_intern_draco_bridge.dylib` ships with 5.2, GLB written |
| Offscreen render, Workbench | works, 0.9 s @ 480×320 |
| Offscreen render, EEVEE (Next) | works, 4.5 s @ 480×320 — correctly lit and shaded |
| Offscreen render, Cycles | works, 0.6 s @ 480×320 |
| `uv` / `uvx` installed | **no** — blender-mcp needs it |
| blender-mcp verified on Blender 5.2 | **no** — add-on targets 4.x-era APIs; extensions system changed in 4.2+ |

The third row is the one that decides it: **headless Blender has a closed visual QA loop.** The batch
script can render a contact sheet to PNG, and those PNGs get read back and inspected. Headless is not
blind, so the usual reason to prefer a GUI disappears for everything except creative shaping.

### Why headless wins for the batch stage

1. **Reproducibility is a PRD requirement.** "Each demo can load a pinned snapshot and transform
   version" (NFR) and every dataset needs a `transform_version`. A committed script re-run from
   `--factory-startup` produces a byte-comparable result. Interactive MCP edits are not replayable.
2. **Memory.** 8 GB unified. GUI Blender idles around 1.2–2 GB and grows with a 4×4 km city; Chrome
   plus the Vite dev server plus the twin needs that headroom. Perf benchmarks are invalid with
   Blender open, so the two modes cannot overlap anyway.
3. **It already works.** Zero new dependencies, verified above. blender-mcp needs `uv` installed and
   an add-on of unverified 5.2 compatibility. Keeping that off the critical path is free.
4. **Volume.** The ordinary-building bake is thousands of footprints across 16 tiles × 2 LODs. That
   is a loop, not a modelling task. Nobody should drive it by conversation.

### Why headed + MCP still earns a place

The 3–5 hero landmarks are the one genuinely visual task: proportion against reference photos,
silhouette readability at 200 m, "does this read as India Gate at LOD1". That needs eyes on a
viewport and fast iteration, which is exactly blender-mcp's strength (`execute_blender_code` against
a live scene, plus viewport screenshots and its Poly Haven / asset helpers).

**Bounded to one sprint (Phase 4, ≤3 days) with a hard exit rule:**

- Every session ends by saving `blender/landmarks/<id>.blend` **and** refreshing the deterministic
  export script. As code is discovered in the live session, it gets written into the script.
- Nothing ships that exists only inside a live session.
- `20_landmark_export.py` re-exports every landmark from the committed `.blend` headlessly, and
  **fails the build** if a poly or file-size budget is exceeded. That gate runs in `make assets`,
  so an MCP session cannot smuggle a 4 MB landmark into the build.

### Stage-by-stage split

| Stage | Mode | Rationale |
|---|---|---|
| GeoJSON footprints → prism extrusion → per-tile merge → material assignment → LOD decimate → GLB+Draco | **Headless** | Deterministic, loopy, CI-able, no GUI RAM |
| Contact-sheet QA renders of each baked tile | **Headless** | Objective, repeatable, reviewable as PNG |
| Hero landmark modelling and proportion tuning | **Headed + MCP** | Needs viewport judgement |
| Landmark → footprint alignment / scale / north verification | **Headless render + footprint overlay diff** | Must be measured, not eyeballed |
| Debugging a bad bake | **Headed**, open the intermediate `.blend` | Inspect what the script actually produced |

### Fallbacks if blender-mcp will not run on 5.2

- **A.** Install Blender 4.5 LTS side-by-side purely as the MCP authoring host; keep 5.2 for the
  headless bake. Two binaries, no conflict.
- **B.** Headed Blender launched with a small script-reload watcher: edit the landmark script, Blender
  re-runs it, look at the viewport. Slower loop than MCP, zero add-on risk, and the output is a
  script by construction.

Neither fallback touches the critical path, because the critical path never needed MCP.

## What actually renders in the browser, and what gets baked

This matters more than the Blender mode, and the naive reading of the PRD ("3D asset pipeline:
Blender → glTF/GLB") would get it wrong. Roads must be **runtime** geometry.

| Content | Where built | Why |
|---|---|---|
| Roads, water, rail/metro lines | **Runtime**, Three.js ribbon geometry from GeoJSON polylines | Corridor colour is *data* — it changes with time, traffic state and scenario. Baking it into a GLB would freeze the analytical layer. |
| Ordinary buildings (~thousands) | **Baked headless** to per-tile GLB + Draco | Static, never recoloured. Baking gives one merged draw call per tile, decode instead of extrude on load, and consistent LODs. |
| 3–5 hero landmarks | **Authored headed**, exported headless, 3 LODs | Orientation anchors; the only thing worth hand-modelling. |
| Buses | **Runtime** instanced mesh on sampled route polylines | Positions are simulated per frame. |

Spike-0 measures baked-tile transfer size against runtime extrusion of the same footprints. If the
bake exceeds the 900 KB/tile budget, ordinary buildings move to runtime extrusion in a Web Worker and
Blender's role narrows to landmarks only. That is a budget decision, so it gets measured, not argued.

## Headless invocation contract

    blender --background --factory-startup --python blender/scripts/10_build_tiles.py -- \
        --config config/study-area.json --in snapshots/v1/buildings.geojson \
        --out web/public/data/@v1/tiles/buildings --lod 0,1

`--factory-startup` is mandatory: it stops a user preference, enabled add-on or leftover startup file
from changing the output, which is the whole point of the reproducibility gate. Everything after `--`
is the script's own argv.

### Two traps that account for most pipeline defects

1. **Axis convention.** Blender is Z-up, Three.js is Y-up. Export with `export_yup=True` (the glTF
   exporter's default) and *never* also rotate the object. Doing both is the classic
   "city lying on its side" bug. Assert it: the QA render script checks a known landmark's
   bounding-box height is on +Y after a round-trip import.
2. **Origin drift.** Every asset must be built with the *same* local origin from
   `config/study-area.json`, and tile GLBs must be exported in tile-local coordinates with the tile
   offset recorded in the manifest — not in absolute metres. Absolute metres at 4 km scale still fits
   float32, but tile-local keeps precision headroom and makes tiles independently cacheable.

## Scripts to build (`blender/scripts/`)

| Script | Job |
|---|---|
| `lib/geo.py` | Load config, apply local origin, tile-local transforms, axis assertions |
| `lib/extrude.py` | Footprint polygon → bmesh ngon → solidify to height; concave ngons OK, courtyard holes deferred |
| `lib/materials.py` | Small restrained PBR palette, assigned by building class; vertex-colour variation so one tile stays one material |
| `lib/lod.py` | Decimate / block-merge rules per LOD level |
| `lib/export.py` | GLB + Draco export, budget assertion, checksum, manifest fragment |
| `10_build_tiles.py` | Ordinary buildings: the 16-tile bake |
| `20_landmark_export.py` | Landmarks: committed `.blend` → 3 LODs → GLB, budget-gated |
| `30_qa_render.py` | Offscreen contact sheets — per tile, per landmark, per LOD, plus a footprint-overlay alignment check |

Blender's bundled Python (3.13.13) has no geopandas/shapely, and it should stay that way. All spatial
work — clipping, projection, simplification, triangulation of anything awkward — happens in the
Python 3.12 pipeline venv and arrives at Blender as plain pre-projected GeoJSON. Blender's only job
is mesh construction and export.

## blender-mcp setup (Phase 0, non-blocking)

    brew install uv
    git clone https://github.com/ahujasid/blender-mcp ~/tools/blender-mcp
    # Blender > Edit > Preferences > Add-ons > Install from Disk > addon.py
    # 3D viewport > N sidebar > BlenderMCP > Connect  (port 9876)
    claude mcp add blender -- uvx blender-mcp

Verify against Blender 5.2 before relying on it. If the add-on fails to register, take fallback A or B
and carry on — the bake does not depend on it.
