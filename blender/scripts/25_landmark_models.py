"""Headless parametric landmark models — the Phase 4 sprint, done as scripts.

The plan called for a headed Blender + blender-mcp session to hand-model these. ADR-002 also said
every headed session must exit to a committed `.blend` **plus a deterministic export script**,
because interactive edits are not replayable. For monuments whose form is this regular — a
triumphal arch, a circular colonnade, a block with a central dome — the script *is* the better
artefact: it is reproducible, it re-runs when a footprint changes, and it is reviewable as a diff.

**What these are.** Stylised reconstructions of characteristic form, built on each landmark's real
OSM footprint and its real height where OSM has one. Every one is a recognisable silhouette, not a
survey: no measured drawings, photogrammetry or elevation data were used, and the ornament of the
real buildings is not attempted. `landmarks/index.json` records `source: "parametric"` so the app
distinguishes them from both hand-authored models and plain massing blocks, and says so in the UI.

Dimensions that are not from OSM are named in DIMENSIONS below with their basis.

Run:
  blender --background --factory-startup --python blender/scripts/25_landmark_models.py -- \
      --config config/study-area.json --out web/public/data/@v1/landmarks
"""
import bpy, json, os, sys, math, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import dptblend as D

A = D.parse_args({
    "config": "config/study-area.json",
    "landmarks": "web/public/data/@v1/landmarks.json",
    "out": "web/public/data/@v1/landmarks",
    "report": "snapshots/v1/landmark-report.json",
})

cfg = json.load(open(A["config"]))
B = cfg["budgets"]
LOD_KB = [B["landmark_lod0_kb"], B["landmark_lod1_kb"], B["landmark_lod2_kb"]]
LOD_DECIMATE = [1.0, 0.55, 0.30]
# Decimating a colonnade turns it into mush: the collapse solver cannot tell a column from noise.
# So the detail that matters is authored per LOD instead — fewer, coarser columns further out —
# and decimation only cleans up what is left.
LOD_DETAIL = [
    {"col_scale": 1.00, "col_segs": 7, "dome_segs": 32, "dome_rings": 10},
    {"col_scale": 0.42, "col_segs": 5, "dome_segs": 20, "dome_rings": 7},
    {"col_scale": 0.16, "col_segs": 4, "dome_segs": 12, "dome_rings": 4},
]

# Published dimensions used where OSM has none. Everything else comes from the footprint.
DIMENSIONS = {
    "india-gate": {"height_m": 42.0, "arch_span_m": 9.1,
                   "basis": "Published monument dimensions; OSM way/361709652 carries no height tag."},
    "old-parliament-house": {"columns": 144,
                             "basis": "The colonnade of the old Parliament has 144 columns; height 21 m is the OSM tag."},
}

STONE = (0.74, 0.60, 0.46)      # Dholpur / Bharatpur sandstone, the material of Lutyens' Delhi
CREAM = (0.80, 0.74, 0.62)
COPPER = (0.42, 0.52, 0.46)


def ring_to_blender(ring, centroid):
    """Runtime (x, z) -> Blender (x, y), centred on the landmark so the GLB is position-free."""
    cx, cz = centroid
    return [(x - cx, -(z - cz)) for x, z in ring]


def ring_extent(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return max(xs) - min(xs), max(ys) - min(ys)


def footprint_solid(name, ring, height, base=0.0, solid=False):
    """`solid=True` caps the floor, which any boolean target must have — see prism_mesh."""
    ob, _nv, _nt = D.prism_mesh(name, [{"r": [[x, -y] for x, y in ring], "h": height}],
                                cap_bottom=solid)
    if base:
        ob.location.z = base
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    return ob


# ---------------------------------------------------------------- per-landmark builders
def build_india_gate(ring, h, lod=0):
    """A triumphal arch: solid pylon with the arch opening cut through it, cornice, attic, bowl."""
    d = DIMENSIONS["india-gate"]
    h = d["height_m"]
    w, dep = ring_extent(ring)
    parts = []

    plinth = footprint_solid("ig_plinth", ring, 3.2)
    parts.append(plinth)

    # main pylon, slightly inset from the plinth
    # capped: this is the boolean target, and an open mesh makes the EXACT solver return the
    # cutter's shape instead of the difference
    pylon = footprint_solid("ig_pylon", [(x * 0.88, y * 0.88) for x, y in ring], h * 0.72,
                            base=3.2, solid=True)

    # cut the arch: a box with a half-cylinder cap, running through the long axis
    span = d["arch_span_m"]
    spring = h * 0.34                      # height at which the arch begins to curve
    # Two sequential subtractions rather than one joined cutter: joining two solids into a single
    # mesh gives interpenetrating shells, and each operand here is a proper closed solid on its own.
    cutter_box = D.box("ig_cut_box", span, dep * 2.0, spring, at=(0, 0, 3.2 + spring / 2))
    D.boolean_difference(pylon, cutter_box)

    cutter_arch = D.cylinder("ig_cut_arch", span / 2, dep * 2.0, segs=24, base_z=0)
    cutter_arch.rotation_euler = (math.pi / 2, 0, 0)
    cutter_arch.location = (0, dep, 3.2 + spring)
    bpy.context.view_layer.objects.active = cutter_arch
    cutter_arch.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
    cutter_arch.select_set(False)
    D.boolean_difference(pylon, cutter_arch)
    parts.append(pylon)

    # cornice, attic and the flame bowl on top
    top = 3.2 + h * 0.72
    parts.append(footprint_solid("ig_cornice", [(x * 0.96, y * 0.96) for x, y in ring], 2.4, base=top))
    parts.append(footprint_solid("ig_attic", [(x * 0.80, y * 0.80) for x, y in ring],
                                 h - top - 2.4 - 3.0, base=top + 2.4))
    dl = LOD_DETAIL[lod]
    parts.append(D.dome("ig_bowl", min(w, dep) * 0.30, 3.0,
                        segs=max(dl["dome_segs"] - 8, 8), rings=max(dl["dome_rings"] - 4, 3),
                        base_z=h - 3.0, squash_top=0.85))
    return D.join_all(parts, "india-gate"), STONE


def build_old_parliament(ring, h, lod=0):
    """Circular colonnade: a drum inside a ring of 144 columns, under a central dome."""
    dl = LOD_DETAIL[lod]
    n = max(int(DIMENSIONS["old-parliament-house"]["columns"] * dl["col_scale"]), 16)
    w, dep = ring_extent(ring)
    rad = min(w, dep) / 2
    parts = []
    parts.append(footprint_solid("op_plinth", ring, 2.6))
    # the colonnade is the building's whole character, so it gets the real column count
    parts.append(D.colonnade("op_cols", ring, n, col_radius=0.85, height=h - 6.0, inset=3.0,
                             segs=dl["col_segs"]))
    ent = footprint_solid("op_entablature", [(x * 1.01, y * 1.01) for x, y in ring], 2.2,
                          base=2.6 + h - 6.0)
    parts.append(ent)
    parts.append(footprint_solid("op_drum", [(x * 0.72, y * 0.72) for x, y in ring], h - 4.0, base=2.6))
    parts.append(D.dome("op_dome", rad * 0.40, rad * 0.30,
                        segs=dl["dome_segs"], rings=dl["dome_rings"], base_z=h - 1.4))
    parts.append(D.cylinder("op_lantern", rad * 0.06, rad * 0.10, segs=max(dl["col_segs"] + 3, 8),
                            base_z=h - 1.4 + rad * 0.30))
    return D.join_all(parts, "old-parliament-house"), CREAM


def build_secretariat_block(ring, h, name, lod=0):
    """North and South Block: a long mass with a colonnaded front and a central dome on a drum."""
    w, dep = ring_extent(ring)
    rad = min(w, dep) / 2
    parts = [footprint_solid(f"{name}_mass", ring, h)]
    parts.append(footprint_solid(f"{name}_cornice", [(x * 1.02, y * 1.02) for x, y in ring],
                                 1.8, base=h - 1.8))
    dl = LOD_DETAIL[lod]
    parts.append(D.colonnade(f"{name}_cols", ring, max(int(56 * dl["col_scale"]), 12),
                             col_radius=1.0, height=h * 0.62, inset=1.4, segs=dl["col_segs"]))
    parts.append(D.cylinder(f"{name}_drum", rad * 0.34, 6.0, segs=dl["dome_segs"] - 6, base_z=h))
    parts.append(D.dome(f"{name}_dome", rad * 0.34, rad * 0.42,
                        segs=dl["dome_segs"], rings=dl["dome_rings"], base_z=h + 6.0))
    return D.join_all(parts, name), STONE


def build_rashtrapati(ring, h, lod=0):
    """A very large block under a single copper dome on a colonnaded drum."""
    w, dep = ring_extent(ring)
    rad = min(w, dep) / 2
    parts = [footprint_solid("rb_mass", ring, h)]
    parts.append(footprint_solid("rb_cornice", [(x * 1.015, y * 1.015) for x, y in ring],
                                 2.0, base=h - 2.0))
    dl = LOD_DETAIL[lod]
    parts.append(D.colonnade("rb_cols", ring, max(int(72 * dl["col_scale"]), 14),
                             col_radius=1.1, height=h * 0.55, inset=1.6, segs=dl["col_segs"]))
    parts.append(D.cylinder("rb_drum", rad * 0.30, 8.0, segs=dl["dome_segs"] - 4, base_z=h))
    parts.append(D.dome("rb_dome", rad * 0.30, rad * 0.40,
                        segs=dl["dome_segs"] + 2, rings=dl["dome_rings"] + 1, base_z=h + 8.0))
    return D.join_all(parts, "rashtrapati-bhavan"), STONE


def build_new_parliament(ring, h, lod=0):
    """The footprint is already the triangle, so the form comes from stepping it back."""
    parts = [footprint_solid("np_base", ring, h * 0.45)]
    parts.append(footprint_solid("np_mid", [(x * 0.90, y * 0.90) for x, y in ring],
                                 h * 0.35, base=h * 0.45))
    parts.append(footprint_solid("np_top", [(x * 0.74, y * 0.74) for x, y in ring],
                                 h * 0.20, base=h * 0.80))
    w, dep = ring_extent(ring)
    parts.append(D.cylinder("np_finial", min(w, dep) * 0.05, 6.0,
                            segs=max(LOD_DETAIL[lod]["col_segs"] + 5, 8), base_z=h))
    return D.join_all(parts, "new-parliament-house"), CREAM


BUILDERS = {
    "india-gate": build_india_gate,
    "old-parliament-house": build_old_parliament,
    "rashtrapati-bhavan": build_rashtrapati,
    "new-parliament-house": build_new_parliament,
    "north-block": lambda r, h, lod=0: build_secretariat_block(r, h, "north-block", lod),
    "south-block": lambda r, h, lod=0: build_secretariat_block(r, h, "south-block", lod),
}

MATERIAL_NOTE = {STONE: "sandstone", CREAM: "cream stucco", COPPER: "copper"}

feats = json.load(open(A["landmarks"]))["features"]
results, failures, skipped_open, built_ids = [], [], [], []
t_all = time.time()

for f in feats:
    lid = f["id"]
    if f.get("kind") == "open":
        skipped_open.append(lid)
        for lod in range(3):
            stale = os.path.join(A["out"], f"{lid}_lod{lod}.glb")
            if os.path.exists(stale):
                os.remove(stale)
        print(f"  {lid:<24} skipped — open ground, renders flat with no massing")
        continue

    builder = BUILDERS.get(lid)
    ring_r = f["ring"]
    if len(ring_r) < 3:
        failures.append(f"{lid}: footprint has {len(ring_r)} points")
        continue
    ring = ring_to_blender(ring_r, f["centroid"])
    height = f["height_m"] or 14.0

    for lod, (ratio, kb_limit) in enumerate(zip(LOD_DECIMATE, LOD_KB)):
        D.reset_scene()
        if builder:
            ob, rgb = builder(ring, height, lod)
            source = "parametric"
        else:
            ob = footprint_solid(lid, ring, height)
            rgb = STONE
            source = "placeholder"
        if ob is None:
            failures.append(f"{lid}: builder produced nothing")
            break
        ob.data.materials.append(D.flat_material(f"mat_{lid}", rgb))

        if ratio < 1.0 and len(ob.data.polygons) >= 40:
            mod = ob.modifiers.new("dpt_lod", "DECIMATE")
            mod.ratio = ratio
            mod.use_collapse_triangulate = True

        # count the evaluated mesh: len(ob.data.polygons) is the pre-modifier count, and the
        # exporter applies the stack, so the two disagree wherever a decimate is present
        dg = bpy.context.evaluated_depsgraph_get()
        faces = len(ob.evaluated_get(dg).to_mesh().polygons)

        path = os.path.join(A["out"], f"{lid}_lod{lod}.glb")
        size = D.export_glb(path, draco=False)
        kb = size / 1024
        over = kb > kb_limit
        if over:
            failures.append(f"{lid} LOD{lod}: {kb:.1f} KB over the {kb_limit} KB budget")
        results.append({"id": lid, "lod": lod, "source": source, "bytes": size,
                        "kb": round(kb, 1), "budget_kb": kb_limit, "over_budget": over,
                        "faces": faces,
                        "placed_at": f["centroid"], "height_m": f["height_m"],
                        "required": f["required"]})
        if lod == 0:
            built_ids.append((lid, source, faces))
        print(f"  {lid:<24} LOD{lod}  {kb:>7.1f} KB / {kb_limit:>4} KB  "
              f"{faces:>6} faces  {source}{'  OVER BUDGET' if over else ''}")

ok, dims = (True, {})
if results:
    D.reset_scene()
    ok, dims = D.assert_yup(os.path.join(A["out"], f"{results[0]['id']}_lod0.glb"))

index = {}
for r in results:
    e = index.setdefault(r["id"], {"source": r["source"], "lods": [], "height_m": r["height_m"],
                                   "required": r["required"]})
    e["lods"].append(r["lod"])
for lid in skipped_open:
    index[lid] = {"source": "open_ground", "lods": [], "height_m": None, "required": False}

report = {
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    "blender": bpy.app.version_string,
    "seconds": round(time.time() - t_all, 1),
    "axis_roundtrip_ok": ok, "axis_dims": dims,
    "method": "parametric — stylised reconstruction of characteristic form on the real OSM footprint and height. Not a survey.",
    "published_dimensions_used": DIMENSIONS,
    "skipped_open_ground": sorted(skipped_open),
    "parametric": sorted({r["id"] for r in results if r["source"] == "parametric"}),
    "placeholders": sorted({r["id"] for r in results if r["source"] == "placeholder"}),
    "assets": results,
    "failures": failures,
}
os.makedirs(os.path.dirname(A["report"]), exist_ok=True)
json.dump(report, open(A["report"], "w"), indent=2)
json.dump({"generated_at": report["generated_at"], "landmarks": index},
          open(os.path.join(A["out"], "index.json"), "w"), indent=2)

print(f"\n  {len(results)} assets in {time.time() - t_all:.1f}s — "
      f"{len(report['parametric'])} parametric, {len(report['placeholders'])} plain massing, "
      f"{len(skipped_open)} open ground")
for lid, src, faces in built_ids:
    print(f"    {lid:<24} {src:<12} {faces:>6} faces")
if failures:
    print("\n  BUDGET GATE FAILED")
    for x in failures:
        print(f"    - {x}")
    sys.exit(1)
print("  budget gate passed")
