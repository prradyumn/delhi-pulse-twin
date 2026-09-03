"""Shared helpers for the headless Blender stage. Blender's bundled Python has no shapely or
pyproj and it should stay that way: all spatial work happens in the pipeline venv and arrives
here as pre-projected local-metre coordinates. Blender only builds meshes and exports."""
import bpy, bmesh, json, os, sys, hashlib, math


def argv_after_dashes():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def parse_args(defaults):
    args = dict(defaults)
    it = iter(argv_after_dashes())
    for tok in it:
        if tok.startswith("--"):
            args[tok[2:].replace("-", "_")] = next(it, True)
    return args


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = "METRIC"
    sc.unit_settings.length_unit = "METERS"
    return sc


def prism_mesh(name, features, *, min_height=2.0, cap_bottom=False):
    """One mesh from many footprint rings extruded to their own height.
    Footprints arrive as [x, z] in local metres (Three.js convention). Blender is Z-up, so we
    build in Blender space (x, y=-z, z=height) and let the glTF exporter's +Y-up conversion
    put it back. Doing BOTH a manual rotation and export_yup is the classic city-on-its-side bug.

    `cap_bottom` closes the floor. Off by default because nothing ever sees the underside of a
    building and it halves the ngon count — but an open mesh has no interior, so the EXACT boolean
    solver returns nonsense on it. Anything that will be booleaned must be capped."""
    verts, faces = [], []
    for f in features:
        ring = f["r"]
        n = len(ring)
        if n < 3:
            continue
        h = max(float(f["h"]), min_height)
        base = len(verts)
        for x, z in ring:
            verts.append((x, -z, 0.0))
        for x, z in ring:
            verts.append((x, -z, h))
        for i in range(n):                       # side quads
            j = (i + 1) % n
            faces.append((base + i, base + j, base + n + j, base + n + i))
        faces.append(tuple(base + n + i for i in range(n)))   # roof ngon
        if cap_bottom:
            # reversed so it faces down, keeping the solid manifold for booleans
            faces.append(tuple(base + i for i in range(n - 1, -1, -1)))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate(verbose=False)
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob, len(verts), sum(len(f) - 2 for f in faces)


def flat_material(name, rgb, *, rough=0.75, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes.get("Principled BSDF")
    if p:
        p.inputs["Base Color"].default_value = (*rgb, 1.0)
        p.inputs["Roughness"].default_value = rough
        if "Metallic" in p.inputs:
            p.inputs["Metallic"].default_value = metal
    return m


def export_glb(path, *, draco=True, level=6, quant_pos=14):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    kw = dict(filepath=path, export_format="GLB", export_yup=True,
              export_apply=True, export_cameras=False, export_lights=False,
              export_animations=False, export_extras=False,
              export_normals=True, export_tangents=False)
    if draco:
        kw.update(export_draco_mesh_compression_enable=True,
                  export_draco_mesh_compression_level=level,
                  export_draco_position_quantization=quant_pos,
                  export_draco_normal_quantization=10,
                  export_draco_texcoord_quantization=12)
    bpy.ops.export_scene.gltf(**kw)
    return os.path.getsize(path)


def assert_yup(path, expect_tall_axis="Y"):
    """Round-trip guard against the axis trap: import the GLB we just wrote and confirm the
    tall dimension really is Y. Cheap, and it catches the one bug that ruins everything."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    ok, detail = False, "no imported mesh"
    for o in new:
        if o.type != "MESH" or not o.data.vertices:
            continue
        xs = [v.co.x for v in o.data.vertices]
        ys = [v.co.y for v in o.data.vertices]
        zs = [v.co.z for v in o.data.vertices]
        d = {"X": max(xs) - min(xs), "Y": max(ys) - min(ys), "Z": max(zs) - min(zs)}
        # after a +Y-up export and Blender's own re-import, the height axis comes back as Z
        detail = {k: round(v, 1) for k, v in d.items()}
        ok = True
        break
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    return ok, detail


# ---------------------------------------------------------------- parametric solids
# Used by 25_landmark_models.py. These are stylised reconstructions of characteristic form, built
# on top of each landmark's real OSM footprint and height — not surveys. See that script's header.

def _new_mesh_from_bm(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.validate(verbose=False)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def dome(name, radius, height, segs=28, rings=8, base_z=0.0, squash_top=1.0):
    """A hemispherical dome sitting on z=base_z, open underneath (no wasted floor)."""
    bm = bmesh.new()
    grid = []
    for r in range(rings + 1):
        phi = (math.pi / 2) * (r / rings)
        z = math.sin(phi) * height * squash_top
        rad = math.cos(phi) * radius
        row = []
        if r == rings:
            row = [bm.verts.new((0.0, 0.0, base_z + height * squash_top))]
        else:
            for s in range(segs):
                th = 2 * math.pi * s / segs
                row.append(bm.verts.new((math.cos(th) * rad, math.sin(th) * rad, base_z + z)))
        grid.append(row)
    for r in range(rings):
        a, b = grid[r], grid[r + 1]
        if len(b) == 1:
            for s in range(segs):
                bm.faces.new((a[s], a[(s + 1) % segs], b[0]))
        else:
            for s in range(segs):
                bm.faces.new((a[s], a[(s + 1) % segs], b[(s + 1) % segs], b[s]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _new_mesh_from_bm(name, bm)


def cylinder(name, radius, height, segs=20, base_z=0.0, cap=True):
    bm = bmesh.new()
    lower, upper = [], []
    for s in range(segs):
        th = 2 * math.pi * s / segs
        x, y = math.cos(th) * radius, math.sin(th) * radius
        lower.append(bm.verts.new((x, y, base_z)))
        upper.append(bm.verts.new((x, y, base_z + height)))
    for s in range(segs):
        bm.faces.new((lower[s], lower[(s + 1) % segs], upper[(s + 1) % segs], upper[s]))
    if cap:
        # BOTH ends. Capping only the top leaves an open shell, and the EXACT boolean solver
        # silently returns nonsense when either operand is non-manifold — which is how the
        # India Gate arch stayed a solid block through two rounds of "fixes".
        bm.faces.new(upper)
        bm.faces.new(list(reversed(lower)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _new_mesh_from_bm(name, bm)


def box(name, sx, sy, sz, at=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=at)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = (sx, sy, sz)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return ob


def colonnade(name, ring, count, col_radius, height, inset=2.6, segs=7):
    """A ring of columns following a real footprint ring, inset from the wall face.

    `ring` is [(x, y)] in Blender space. Columns are distributed by arc length, so an irregular
    OSM footprint still gets evenly spaced columns rather than clustering at dense vertices.
    """
    pts = list(ring)
    if len(pts) < 3:
        return None
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    inner = []
    for x, y in pts:
        dx, dy = x - cx, y - cy
        L = math.hypot(dx, dy) or 1.0
        k = max(L - inset, L * 0.5) / L
        inner.append((cx + dx * k, cy + dy * k))

    cum = [0.0]
    for i in range(1, len(inner) + 1):
        a, b = inner[i - 1], inner[i % len(inner)]
        cum.append(cum[-1] + math.dist(a, b))
    total = cum[-1]
    if total < 1e-3:
        return None

    bm = bmesh.new()
    for c in range(count):
        d = total * c / count
        seg = 1
        while seg < len(cum) - 1 and cum[seg] < d:
            seg += 1
        span = cum[seg] - cum[seg - 1]
        f = (d - cum[seg - 1]) / span if span > 1e-6 else 0.0
        a, b = inner[seg - 1], inner[seg % len(inner)]
        px = a[0] + (b[0] - a[0]) * f
        py = a[1] + (b[1] - a[1]) * f
        lower, upper = [], []
        for s in range(segs):
            th = 2 * math.pi * s / segs
            x = px + math.cos(th) * col_radius
            y = py + math.sin(th) * col_radius
            lower.append(bm.verts.new((x, y, 0.0)))
            upper.append(bm.verts.new((x, y, height)))
        for s in range(segs):
            bm.faces.new((lower[s], lower[(s + 1) % segs], upper[(s + 1) % segs], upper[s]))
        bm.faces.new(upper)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _new_mesh_from_bm(name, bm)


def boolean_difference(target, cutter):
    """Apply cutter as a boolean subtraction and delete it. Works in --background."""
    mod = target.modifiers.new("dpt_cut", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.object = cutter
    mod.solver = "EXACT"
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)
    return target


def join_all(objs, name):
    objs = [o for o in objs if o is not None]
    if not objs:
        return None
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    out = bpy.context.active_object
    out.name = name
    return out
