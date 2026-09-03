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


def footprint_solid(name, ring, height, base=0.0, solid=True):
    """Closed by default.

    A boolean target must have a floor or the EXACT solver returns the cutter's shape. But there is
    a second reason to close everything: a closed mesh has a well-defined signed volume, which is
    what `dptblend.orient_outward` uses to guarantee the normals face out. An open prism has no
    such test, so it can only be checked by eye. The floor of a monument sitting on the ground is
    never visible; the handful of triangles is worth the invariant."""
    ob, _nv, _nt = D.prism_mesh(name, [{"r": [[x, -y] for x, y in ring], "h": height}],
                                cap_bottom=solid)
    if base:
        ob.location.z = base
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    return ob


# ---------------------------------------------------------------- per-landmark builders
def _band(name, ring, height, base, scale):
    """A moulding course: the footprint scaled about its own centre. Landmark GLBs are exported
    centred on the landmark, so scaling the ring is scaling about the building's axis."""
    return footprint_solid(name, [(x * scale, y * scale) for x, y in ring], height, base=base)


def build_india_gate(ring, h, lod=0):
    """A triumphal arch, articulated.

    The previous version of this was 506 triangles — the smallest model in the set, for the object
    at the end of Kartavya Path that every camera path points at. Six prisms and a dome read as a
    lump of stone with a hole in it from anywhere closer than 400 m.

    What was missing was not polygons for their own sake, it was the horizontal articulation that
    makes masonry read as masonry: a stepped approach, a plinth with its own base moulding, a
    string course at the arch springing, a cornice that actually projects and therefore casts a
    shadow line across the facade, a recessed inscription band, and pilasters framing the panels
    on all four faces. Every one of those is a real feature of the monument, and each is a plane
    the sun can catch at a different angle, which is what the eye reads as depth.

    Built additively. The arch opening still needs a boolean, and that one is kept — a triumphal
    arch without the opening is not a triumphal arch — but nothing else here does, because two
    separate non-manifold boolean failures on this exact model already cost an afternoon and
    survived two rounds of 'fixes' by silently returning the cutter's shape.
    """
    d = DIMENSIONS["india-gate"]
    h = d["height_m"]
    dl = LOD_DETAIL[lod]
    fine = lod == 0
    w, dep = ring_extent(ring)
    parts = []

    # ---- approach steps, three courses spreading beyond the footprint
    if lod <= 1:
        for i, (sc, hh) in enumerate(((1.34, 0.45), (1.24, 0.45), (1.14, 0.45))):
            parts.append(_band(f"ig_step{i}", ring, hh, 0.45 * i, sc))
    step_top = 1.35 if lod <= 1 else 0.0

    # ---- plinth, with a chamfered base moulding and a top drip
    parts.append(_band("ig_plinth_base", ring, 0.7, step_top, 1.06))
    plinth_h = 3.2
    parts.append(_band("ig_plinth", ring, plinth_h, step_top + 0.7, 1.0))
    parts.append(_band("ig_plinth_cap", ring, 0.55, step_top + 0.7 + plinth_h, 1.05))
    base_z = step_top + 0.7 + plinth_h + 0.55

    # ---- main pylon. Capped: this is the boolean target, and an open mesh makes the EXACT solver
    # return the cutter's shape rather than the difference.
    #
    # 0.50 of the height, not 0.62. At 0.62 the attic above the cornice came out 4.6 m tall on a
    # 42 m monument and the whole top read as a stack of slabs. On the real arch the inscribed
    # attic is a substantial mass — roughly a fifth of the height — and that mass is what stops
    # the silhouette looking like a chimney with a lid.
    shaft_h = h * 0.50
    pylon_ring = [(x * 0.88, y * 0.88) for x, y in ring]
    pylon = footprint_solid("ig_pylon", pylon_ring, shaft_h, base=base_z, solid=True)

    span = d["arch_span_m"]
    spring = shaft_h * 0.52                # height at which the arch begins to curve
    cutter_box = D.box("ig_cut_box", span, dep * 2.0, spring, at=(0, 0, base_z + spring / 2))
    D.boolean_difference(pylon, cutter_box)

    cutter_arch = D.cylinder("ig_cut_arch", span / 2, dep * 2.0, segs=28 if fine else 18, base_z=0)
    cutter_arch.rotation_euler = (math.pi / 2, 0, 0)
    cutter_arch.location = (0, dep, base_z + spring)
    bpy.context.view_layer.objects.active = cutter_arch
    cutter_arch.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
    cutter_arch.select_set(False)
    D.boolean_difference(pylon, cutter_arch)
    parts.append(pylon)

    # ---- pilasters framing the panels either side of the opening, on all four faces.
    # The ring is very nearly a rectangle, so its extent is the right frame to hang these on.
    #
    # Collected in their own list and lifted together. The first version of this reached back into
    # `parts` by a fixed slice to do the lift, mis-counted, and translated the plinth and the pylon
    # up with the pilasters — the kind of arithmetic that produces a model which passes every
    # budget gate and is wrong.
    if fine:
        px, py = w * 0.88 / 2, dep * 0.88 / 2
        pil_w, pil_d, pil_h = 1.5, 0.5, shaft_h - 1.2
        # bite into the pylon by 0.15 m. Sitting exactly on its face makes the two surfaces
        # coplanar, and the render showed the z-fighting as a bright seam up the facade.
        bite = 0.15
        pilasters = []
        # the two narrow faces, four pilasters each
        for i, sx in enumerate((-1, 1)):
            for j, off in enumerate((-0.93, -0.58, 0.58, 0.93)):
                pilasters.append(D.box(f"ig_pil_x{i}{j}", pil_d, pil_w, pil_h,
                                       at=(sx * (px + pil_d / 2 - bite), off * py, 0)))
        # the two broad faces, flanking the arch opening
        for i, sy in enumerate((-1, 1)):
            for j, off in enumerate((-0.88, -0.56, 0.56, 0.88)):
                pilasters.append(D.box(f"ig_pil_y{i}{j}", pil_w, pil_d, pil_h,
                                       at=(off * px, sy * (py + pil_d / 2 - bite), 0)))
        for ob in pilasters:
            ob.location.z = base_z + pil_h / 2 + 0.6
            bpy.context.view_layer.objects.active = ob
            bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
        parts.extend(pilasters)

    # ---- string course at the springing, which is where the real monument breaks the face.
    # Emphatically NOT a continuous band: at 0.93 of the footprint it runs straight through the
    # arch void, and the render showed a stone beam hanging across the opening. It exists only
    # where there is masonry to carry it — the two piers and the two narrow faces.
    if lod <= 1:
        sx_half, sy_half = w * 0.88 / 2, dep * 0.88 / 2
        pier = (sx_half - span / 2) / 2 + span / 2      # centre of each pier, on the broad face
        pier_w = sx_half - span / 2
        for i, sgn in enumerate((-1, 1)):
            for j, sy in enumerate((-1, 1)):
                b = D.box(f"ig_string_p{i}{j}", pier_w, 0.55, 0.5,
                          at=(sgn * pier, sy * (sy_half + 0.1), base_z + spring - 0.25))
                parts.append(b)
            b = D.box(f"ig_string_e{i}", 0.55, dep * 0.88, 0.5,
                      at=(sgn * (sx_half + 0.1), 0, base_z + spring - 0.25))
            parts.append(b)

    # ---- cornice: three courses of increasing then decreasing projection, so it throws a
    # genuine shadow line instead of being a single step
    top = base_z + shaft_h
    parts.append(_band("ig_cornice_a", ring, 0.6, top, 0.93))
    parts.append(_band("ig_cornice_b", ring, 1.1, top + 0.6, 1.00))
    parts.append(_band("ig_cornice_c", ring, 0.7, top + 1.7, 0.95))
    attic_z = top + 2.4

    # ---- attic, with the inscription band recessed between two mouldings
    attic_h = h - attic_z - 4.2
    parts.append(_band("ig_attic_lo", ring, attic_h * 0.18, attic_z, 0.86))
    parts.append(_band("ig_attic_band", ring, attic_h * 0.58, attic_z + attic_h * 0.18, 0.81))
    parts.append(_band("ig_attic_hi", ring, attic_h * 0.24,
                       attic_z + attic_h * 0.76, 0.86))
    crown = attic_z + attic_h

    # ---- the shallow bowl on its own stepped base. Bigger than it was: at 0.28 of the short
    # side it disappeared behind the attic's own cap from any ground-level angle, which is the
    # only angle anyone sees this from.
    parts.append(_band("ig_bowl_base", ring, 0.9, crown, 0.66))
    parts.append(_band("ig_bowl_cap", ring, 0.5, crown + 0.9, 0.58))
    parts.append(D.dome("ig_bowl", min(w, dep) * 0.34, 2.8,
                        segs=max(dl["dome_segs"] - 6, 10), rings=max(dl["dome_rings"] - 3, 4),
                        base_z=crown + 1.4, squash_top=0.78))
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
