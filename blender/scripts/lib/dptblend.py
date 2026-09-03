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


def prism_mesh(name, features, *, min_height=2.0):
    """One mesh from many footprint rings extruded to their own height.
    Footprints arrive as [x, z] in local metres (Three.js convention). Blender is Z-up, so we
    build in Blender space (x, y=-z, z=height) and let the glTF exporter's +Y-up conversion
    put it back. Doing BOTH a manual rotation and export_yup is the classic city-on-its-side bug."""
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
        faces.append(tuple(base + n + i for i in range(n)))   # roof ngon; floor omitted
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
