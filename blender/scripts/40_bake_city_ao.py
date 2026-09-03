"""Bake a top-down sky-visibility map for the whole city.

This is the ambient occlusion the scene needs, and it is baked rather than computed per frame for
a measured reason: screen-space GTAO cost ~18 ms of a 16.7 ms budget on the target device and
roughly doubled submitted geometry. Baking is free at runtime and *better* quality, because it is
not limited to what happens to be on screen.

What it actually computes: how much of the sky each point on the ground can see, given the whole
massing. Courtyards, street canyons and the shadowed side of a block get less. That is exactly the
cue that stops extruded blocks looking like blocks sitting on a plane.

Rendered with an orthographic camera looking straight down at the locked study box, so the result
is a planar texture the runtime can sample with UV = normalised (x, z) — no unwrapping needed.

Run:
  blender --background --factory-startup --python blender/scripts/40_bake_city_ao.py -- \
      --res 2048 --samples 48
"""
import bpy, json, os, sys, time, math
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import dptblend as D

A = D.parse_args({
    "config": "config/study-area.json",
    "buildings": "web/public/data/@v1/buildings.json",
    "landmarks": "web/public/data/@v1/landmarks.json",
    "out": "web/public/data/@v1/bake/city-ao.png",
    "report": "snapshots/v1/ao-bake-report.json",
    "res": "2048",
    "samples": "48",
})
RES = int(A["res"])
SAMPLES = int(A["samples"])

cfg = json.load(open(A["config"]))
ext = cfg["study_area"]["runtime_extent"]
X0, X1 = ext["x"]
Z0, Z1 = ext["z"]
W = X1 - X0
H = Z1 - Z0

t0 = time.time()
D.reset_scene()
sc = bpy.context.scene

# ---- the occluders: every building, plus the landmark massing
feats = json.load(open(A["buildings"]))["features"]
city, nv, nt = D.prism_mesh("city", feats)
# The occluders must be BLACK, not white. With a white albedo they bounce sky light back down
# onto the ground and fill in the very occlusion being measured — the first bake came out 97%
# white with only thin halos at the wall lines. Black occluders only block; they never fill.
occluder = D.flat_material("ao_occluder", (0.0, 0.0, 0.0), rough=1.0)
white = D.flat_material("ao_receiver", (1.0, 1.0, 1.0), rough=1.0)
city.data.materials.append(occluder)

lm_count = 0
if os.path.exists(A["landmarks"]):
    lms = [f for f in json.load(open(A["landmarks"]))["features"]
           if f.get("kind") != "open" and len(f["ring"]) >= 3]
    if lms:
        lm, _a, _b = D.prism_mesh("landmarks", [
            {"r": f["ring"], "h": f["height_m"] or 14.0} for f in lms])
        lm.data.materials.append(occluder)
        lm_count = len(lms)

# ---- the receiver: a plane at ground level covering the whole box
bpy.ops.mesh.primitive_plane_add(size=1.0, location=((X0 + X1) / 2, -(Z0 + Z1) / 2, 0.0))
plane = bpy.context.active_object
plane.scale = (W, H, 1.0)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
plane.data.materials.append(white)

# ---- a pure white sky and NO sun: the render then measures sky visibility, which is the AO
world = bpy.data.worlds.new("ao_sky")
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg:
    bg.inputs[0].default_value = (1.0, 1.0, 1.0, 1.0)
    bg.inputs[1].default_value = 1.0
sc.world = world

sc.render.engine = "CYCLES"
sc.cycles.samples = SAMPLES
sc.cycles.use_denoising = True
# One bounce only, and with black occluders there is nothing to bounce off: the ground value is
# then the fraction of the sky hemisphere it can actually see, which is what AO means.
sc.cycles.max_bounces = 1
sc.cycles.diffuse_bounces = 1
sc.render.resolution_x = RES
sc.render.resolution_y = RES
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "BW"
sc.view_settings.view_transform = "Standard"

# ---- orthographic, straight down, framing the box exactly so UV = normalised (x, z)
cam_data = bpy.data.cameras.new("ao_cam")
cam_data.type = "ORTHO"
cam_data.ortho_scale = max(W, H)
cam_data.clip_start = 1.0
cam_data.clip_end = 4000.0
cam = bpy.data.objects.new("ao_cam", cam_data)
bpy.context.collection.objects.link(cam)
cam.location = ((X0 + X1) / 2, -(Z0 + Z1) / 2, 1200.0)
cam.rotation_euler = (0.0, 0.0, 0.0)     # default camera looks down -Z, which is what we want
sc.camera = cam

# The plane is square in the render but the box is not, so record the aspect for the runtime.
out = os.path.abspath(A["out"])
os.makedirs(os.path.dirname(out), exist_ok=True)
sc.render.filepath = out
bpy.ops.render.render(write_still=True)

size = os.path.getsize(out)
report = {
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    "blender": bpy.app.version_string,
    "engine": "CYCLES", "samples": SAMPLES, "resolution": RES,
    "seconds": round(time.time() - t0, 1),
    "output": A["out"], "bytes": size,
    "occluders": {"buildings": len(feats), "landmarks": lm_count,
                  "verts": nv, "tris": nt},
    "extent": {"x": [X0, X1], "z": [Z0, Z1], "ortho_scale": max(W, H)},
    "uv_mapping": "u = (x - X0) / ortho_scale + centring offset; see the runtime sampler. The "
                  "render is square and the box is not, so both axes normalise by ortho_scale.",
    "what_it_is": "Sky visibility from ground level given the whole massing, rendered top-down "
                  "with a white world and no sun. Not a light map and not a shadow map: it does "
                  "not depend on sun position and stays valid at every hour.",
}
json.dump(report, open(A["report"], "w"), indent=2)
print(f"\n  baked {RES}x{RES} in {report['seconds']}s -> {A['out']} ({size/1024:.0f} KB)")
print(f"  occluders: {len(feats)} buildings + {lm_count} landmarks, {nt:,} tris")
