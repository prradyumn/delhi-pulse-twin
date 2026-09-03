"""Headless: hero landmarks -> GLB at three LODs, budget-gated.

This is Blender's whole remaining job. The Spike-0 bake-off moved ordinary buildings to runtime
extrusion (docs/06-SPIKE-0-BAKEOFF.md), so nothing else here goes through Blender.

Two sources, in priority order:
  1. blender/landmarks/<id>.blend — hand-authored in the Phase 4 headed sprint. Preferred.
  2. the verified OSM footprint from landmarks.json — extruded as a massing block. Correctly
     placed and scaled, deliberately undetailed, and reported as a placeholder so nobody mistakes
     a stand-in for finished work.

Run:
  blender --background --factory-startup --python blender/scripts/20_landmark_export.py -- \
      --config config/study-area.json --out web/public/data/@v1/landmarks
"""
import bpy, json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import dptblend as D

A = D.parse_args({
    "config": "config/study-area.json",
    "landmarks": "web/public/data/@v1/landmarks.json",
    "blends": "blender/landmarks",
    "out": "web/public/data/@v1/landmarks",
    "report": "snapshots/v1/landmark-report.json",
})

cfg = json.load(open(A["config"]))
budgets = cfg["budgets"]
LOD_KB = [budgets["landmark_lod0_kb"], budgets["landmark_lod1_kb"], budgets["landmark_lod2_kb"]]
# ratio applied per LOD; LOD0 keeps authored detail
LOD_DECIMATE = [1.0, 0.45, 0.12]

data = json.load(open(A["landmarks"]))
feats = data["features"]
if not feats:
    sys.exit("landmarks.json has no features — run the pipeline first (make data)")

results, failures = [], []
t_all = time.time()

skipped_open = []
for f in feats:
    lid = f["id"]

    # kind=open is ground, not a building. Exporting a GLB for it would be worse than useless:
    # the runtime layer prefers an authored GLB over its flat-plaza fallback, so a block here
    # would silently override the correct rendering and drop a 41,000 m2 slab on Connaught Place.
    if f.get("kind") == "open":
        skipped_open.append(lid)
        for lod in range(len(LOD_DECIMATE)):
            stale = os.path.join(A["out"], f"{lid}_lod{lod}.glb")
            if os.path.exists(stale):
                os.remove(stale)
                print(f"  {lid:<24} removed stale GLB lod{lod} (kind=open)")
        print(f"  {lid:<24} skipped — open ground, renders flat with no massing")
        continue

    blend = os.path.join(A["blends"], f"{lid}.blend")
    authored = os.path.exists(blend)

    for lod, (ratio, kb_limit) in enumerate(zip(LOD_DECIMATE, LOD_KB)):
        if authored:
            bpy.ops.wm.open_mainfile(filepath=blend)
            objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
            if not objs:
                failures.append(f"{lid}: {blend} contains no mesh")
                break
            src = "blend"
        else:
            D.reset_scene()
            h = f["height_m"] or 12.0
            ob, _nv, _nt = D.prism_mesh(f"landmark_{lid}", [{"r": f["ring"], "h": h}])
            ob.data.materials.append(D.flat_material(f"mat_{lid}", (0.71, 0.63, 0.55)))
            objs = [ob]
            src = "placeholder"

        # move to the origin so the GLB is position-independent; the app places it from the manifest
        cx, cz = f["centroid"]
        for o in objs:
            o.location.x -= cx
            o.location.y += cz          # Blender Y is -Z in runtime coords

        if ratio < 1.0:
            for o in objs:
                if len(o.data.polygons) < 40:
                    continue
                mod = o.modifiers.new("dpt_lod", "DECIMATE")
                mod.ratio = ratio

        path = os.path.join(A["out"], f"{lid}_lod{lod}.glb")
        size = D.export_glb(path, draco=True, quant_pos=13)
        kb = size / 1024
        over = kb > kb_limit
        if over:
            failures.append(f"{lid} LOD{lod}: {kb:.1f} KB exceeds the {kb_limit} KB budget")
        results.append({"id": lid, "lod": lod, "source": src, "bytes": size,
                        "kb": round(kb, 1), "budget_kb": kb_limit, "over_budget": over,
                        "placed_at": [cx, cz], "height_m": f["height_m"],
                        "required": f["required"]})
        print(f"  {lid:<24} LOD{lod}  {kb:>7.1f} KB / {kb_limit:>4} KB  {src}{'  OVER BUDGET' if over else ''}")

ok, dims = (True, {})
if results:
    first = os.path.join(A["out"], f"{results[0]['id']}_lod0.glb")
    D.reset_scene()
    ok, dims = D.assert_yup(first)

report = {
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    "blender": bpy.app.version_string,
    "seconds": round(time.time() - t_all, 1),
    "axis_roundtrip_ok": ok, "axis_dims": dims,
    "skipped_open_ground": sorted(skipped_open),
    "placeholders": sorted({r["id"] for r in results if r["source"] == "placeholder"}),
    "authored": sorted({r["id"] for r in results if r["source"] == "blend"}),
    "assets": results,
    "failures": failures,
}
os.makedirs(os.path.dirname(A["report"]), exist_ok=True)
json.dump(report, open(A["report"], "w"), indent=2)

print(f"\n  {len(results)} assets, {len(report['placeholders'])} still placeholders, "
      f"{len(report['authored'])} authored, {len(skipped_open)} open ground skipped, "
      f"{time.time() - t_all:.1f}s")
if failures:
    print("\n  BUDGET GATE FAILED")
    for x in failures:
        print(f"    - {x}")
    sys.exit(1)
print("  budget gate passed")
