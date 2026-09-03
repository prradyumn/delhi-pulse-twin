"""Headless QA contact sheets.

This is the script that makes headless Blender viable as the pipeline of record: the bake is not
blind, because it renders what it produced to PNG for review. Spike-0 measured EEVEE at 4.5 s and
Workbench at 0.9 s for 480x320 on this machine, so a full sheet is seconds, not minutes.

Three checks, each answering a question you cannot answer from a byte count:

  1. landmark sheet   - does the silhouette still read at LOD1 and LOD2?
  2. alignment sheet  - does the landmark sit on its own OSM footprint, at the right scale?
  3. city overview    - does the massing look like the place, from the default camera?

Run:
  blender --background --factory-startup --python blender/scripts/30_qa_render.py -- \
      --out spike/results/qa
"""
import bpy, json, os, sys, math, time, glob
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import dptblend as D

A = D.parse_args({
    "out": "spike/results/qa",
    "landmarks": "web/public/data/@v1/landmarks.json",
    "buildings": "web/public/data/@v1/buildings.json",
    "glb": "web/public/data/@v1/landmarks",
    "engine": "BLENDER_EEVEE",
    "res": "900",
})
OUT = A["out"]
RES = int(A["res"])
os.makedirs(OUT, exist_ok=True)


def studio(engine=A["engine"], res_x=RES, res_y=int(RES * 0.68)):
    sc = bpy.context.scene
    sc.render.engine = engine if engine in ("CYCLES", "BLENDER_EEVEE", "BLENDER_WORKBENCH") else "BLENDER_EEVEE"
    if sc.render.engine == "CYCLES":
        sc.cycles.samples = 24
    sc.render.resolution_x, sc.render.resolution_y = res_x, res_y
    sc.render.image_settings.file_format = "PNG"
    sc.render.film_transparent = False
    world = bpy.data.worlds.new("qa")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.62, 0.68, 0.74, 1.0)
        bg.inputs[1].default_value = 1.1
    sc.world = world
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(52), 0, math.radians(-38))
    bpy.context.collection.objects.link(sun)
    return sc


def frame_camera(sc, target, radius, elev=math.radians(34), az=math.radians(-40)):
    cam_data = bpy.data.cameras.new("qa_cam")
    cam_data.lens = 42
    cam = bpy.data.objects.new("qa_cam", cam_data)
    bpy.context.collection.objects.link(cam)
    cx, cy, cz = target
    cam.location = (cx + radius * math.cos(elev) * math.sin(az),
                    cy - radius * math.cos(elev) * math.cos(az),
                    cz + radius * math.sin(elev))
    # Aim with Blender's own tracking quaternion rather than hand-rolled Euler angles. A Blender
    # camera looks down its local -Z, and getting that wrong by a sign renders a blank frame with
    # no error — which is exactly what the first pass of this script produced.
    from mathutils import Vector
    direction = Vector((cx, cy, cz)) - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam
    return cam


def shoot(path):
    bpy.context.scene.render.filepath = os.path.abspath(path)
    bpy.ops.render.render(write_still=True)
    return os.path.getsize(bpy.context.scene.render.filepath)


results = []
t0 = time.time()

# ------------------------------------------------------------------ 1 + 2. landmarks
if os.path.exists(A["landmarks"]):
    feats = json.load(open(A["landmarks"]))["features"]
    for f in feats:
        for lod in (0, 1, 2):
            path = os.path.join(A["glb"], f"{f['id']}_lod{lod}.glb")
            if not os.path.exists(path):
                continue
            D.reset_scene()
            sc = studio()
            bpy.ops.import_scene.gltf(filepath=path)
            meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
            if not meshes:
                results.append({"check": "landmark", "id": f["id"], "lod": lod, "status": "no mesh"})
                continue

            # --- alignment: drop the real OSM footprint under it as a flat outline. If the model
            # and the ring disagree, the render shows it immediately and no measurement is needed.
            ring = [[x - f["centroid"][0], z - f["centroid"][1]] for x, z in f["ring"]]
            pad, _nv, _nt = D.prism_mesh(f"footprint_{f['id']}", [{"r": ring, "h": 0.4}])
            pad.data.materials.append(D.flat_material("mat_footprint", (0.85, 0.35, 0.2)))
            pad.location.z = -0.2

            dims = [max((max(v.co[i] for v in m.data.vertices) -
                         min(v.co[i] for v in m.data.vertices)) for m in meshes) for i in range(3)]
            span = max(max(dims), 12.0)
            frame_camera(sc, (0, 0, span * 0.25), span * 2.4)
            size = shoot(os.path.join(OUT, f"landmark_{f['id']}_lod{lod}.png"))
            tris = sum(len(m.data.polygons) for m in meshes)
            results.append({"check": "landmark", "id": f["id"], "lod": lod, "status": "ok",
                            "png_bytes": size, "faces": tris,
                            "bbox_m": [round(d, 1) for d in dims],
                            "footprint_area_m2": f["area_m2"],
                            "declared_height_m": f["height_m"]})
            print(f"  landmark {f['id']:<24} LOD{lod}  faces={tris:<6} bbox={[round(d) for d in dims]}")
else:
    print(f"  !! {A['landmarks']} missing — run: python3 pipeline/fetch_landmarks.py && make data")

# ------------------------------------------------------------------ 3. city overview
if os.path.exists(A["buildings"]):
    data = json.load(open(A["buildings"]))
    D.reset_scene()
    sc = studio(res_x=RES, res_y=int(RES * 0.6))
    ob, nv, nt = D.prism_mesh("city", data["features"])
    ob.data.materials.append(D.flat_material("mat_city", (0.66, 0.62, 0.57)))
    # a ground plate so the massing does not float in the void
    bpy.ops.mesh.primitive_plane_add(size=4400, location=(0, 0, -0.4))
    plate = bpy.context.active_object
    plate.data.materials.append(D.flat_material("mat_plate", (0.74, 0.70, 0.63)))
    for name, az, elev in (("overview_ne", math.radians(-40), math.radians(30)),
                           ("overview_top", 0.0, math.radians(88))):
        frame_camera(sc, (0, 0, 0), 4200, elev=elev, az=az)
        size = shoot(os.path.join(OUT, f"city_{name}.png"))
        results.append({"check": "city", "view": name, "status": "ok",
                        "png_bytes": size, "verts": nv, "tris": nt})
        print(f"  city {name:<14} verts={nv:,} tris={nt:,}")
else:
    print(f"  !! {A['buildings']} missing — run: make data")

report = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
          "blender": bpy.app.version_string,
          "engine": bpy.context.scene.render.engine,
          "seconds": round(time.time() - t0, 1),
          "out_dir": os.path.abspath(OUT),
          "sheets": results}
json.dump(report, open(os.path.join(OUT, "qa-report.json"), "w"), indent=2)
print(f"\n  {len(results)} sheets in {time.time() - t0:.1f}s -> {os.path.abspath(OUT)}")
print("  review the PNGs; the orange outline under each landmark is its real OSM footprint")
