"""Headless: buildings.json -> one GLB with two meshes (observed / estimated height).
Run:
  blender --background --factory-startup --python blender/scripts/10_build_buildings.py -- \
      --in web/public/data/@v1/buildings.json --out web/public/data/@v1/buildings.glb
"""
import bpy, json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import dptblend as D

A = D.parse_args({"in": "web/public/data/@v1/buildings.json",
                  "out": "web/public/data/@v1/buildings.glb",
                  "report": "snapshots/v1/bake-report.json"})

t0 = time.time()
data = json.load(open(A["in"]))
feats = data["features"]
D.reset_scene()

# Split by height mode so the runtime can show which heights are guessed. That split is a
# trust feature, not a rendering nicety: 91.8% of this box has an estimated height.
groups = {"observed": [f for f in feats if f["m"] == 0],
          "estimated": [f for f in feats if f["m"] == 1]}
palette = {"observed": (0.62, 0.60, 0.57), "estimated": (0.56, 0.55, 0.54)}

stats = {}
for name, fs in groups.items():
    if not fs:
        continue
    ob, nv, ntri = D.prism_mesh(f"buildings_{name}", fs)
    ob.data.materials.append(D.flat_material(f"mat_buildings_{name}", palette[name]))
    stats[name] = {"footprints": len(fs), "verts": nv, "tris": ntri}
    print(f"  {name}: {len(fs):,} footprints -> {nv:,} verts, {ntri:,} tris")

size = D.export_glb(A["out"])
ok, dims = D.assert_yup(A["out"])

# uncompressed comparison, to show what Draco actually buys
raw_path = A["out"].replace(".glb", "_nodraco.glb")
raw_size = D.export_glb(raw_path, draco=False)

report = {
    "source": A["in"], "output": A["out"],
    "height_rule_version": data.get("height_rule_version"),
    "groups": stats,
    "total_footprints": sum(g["footprints"] for g in stats.values()),
    "total_verts": sum(g["verts"] for g in stats.values()),
    "total_tris": sum(g["tris"] for g in stats.values()),
    "glb_draco_bytes": size,
    "glb_nodraco_bytes": raw_size,
    "draco_ratio": round(raw_size / max(size, 1), 2),
    "axis_roundtrip_ok": ok, "axis_dims": dims,
    "bake_seconds": round(time.time() - t0, 1),
    "blender": bpy.app.version_string,
}
os.makedirs(os.path.dirname(A["report"]), exist_ok=True)
json.dump(report, open(A["report"], "w"), indent=2)
print(json.dumps(report, indent=2))
