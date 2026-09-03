"""Generate the facade material atlas: albedo, normal and roughness.

**Why generated rather than photographed.** The data register forbids redistributing imagery we do
not hold rights to (D12), and a photographic facade atlas of Delhi would be exactly that. So every
pixel here is computed. That is a constraint, but it also buys something: the maps can be keyed to
the OSM `building=*` class, so the texture carries information rather than only decoration.

Four cells in a 4x1 strip, each 512px, chosen to match what the building classes in this box
actually look like:

  0  commercial / office   continuous glazing bands, aluminium mullions, dark glass
  1  government / civic    sandstone ashlar courses, deep-set punched windows
  2  residential           plaster, small windows, staining streaks below the sills
  3  retail / mixed        shopfront glazing at the base, plaster above

A strip rather than a grid on purpose: with no vertical cell boundary, `u` selects the class and
`v` is always the storey axis, so the atlas cannot be sampled upside down.

Three maps come out of one height field, which is what keeps them consistent:

  albedo     — colour, with staining and course lines
  normal     — derived analytically from the height field, so recesses light correctly
  roughness  — glass smooth, plaster mid, sandstone coarse

Run:
  blender --background --factory-startup --python blender/scripts/45_bake_facade_atlas.py -- \
      --cell 512 --out web/public/data/@v1/bake
"""
import bpy, os, sys, math, json, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import dptblend as D

A = D.parse_args({"cell": "512", "out": "web/public/data/@v1/bake",
                  "report": "snapshots/v1/facade-atlas-report.json"})
CELL = int(A["cell"])
# A 4x1 strip, not a 2x2 grid. The first attempt used 2x2 and the cell rows came out inverted,
# because Blender's pixel row 0 is the image BOTTOM while a PNG's row 0 is the top. A strip has no
# vertical cell boundary, so class selection is purely horizontal and that whole class of bug is
# gone: u picks the class, v is always the storey axis.
SIZE_X = CELL * 4
SIZE_Y = CELL
OUT = A["out"]
os.makedirs(OUT, exist_ok=True)


# ---------------------------------------------------------------- deterministic noise
def _h(x, y, s=0):
    n = (x * 374761393 + y * 668265263 + s * 2147483647) & 0xFFFFFFFF
    n = (n ^ (n >> 13)) * 1274126177 & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFFFF) / 65535.0


def vnoise(x, y, s=0):
    """Value noise with smooth interpolation — cheap, and identical on every run."""
    xi, yi = math.floor(x), math.floor(y)
    xf, yf = x - xi, y - yi
    u = xf * xf * (3 - 2 * xf)
    v = yf * yf * (3 - 2 * yf)
    a, b = _h(xi, yi, s), _h(xi + 1, yi, s)
    c, d = _h(xi, yi + 1, s), _h(xi + 1, yi + 1, s)
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v


def fbm(x, y, s=0, oct=4):
    t, amp, f = 0.0, 0.5, 1.0
    for _ in range(oct):
        t += vnoise(x * f, y * f, s) * amp
        amp *= 0.5
        f *= 2.0
    return t


def smoothstep(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0 + 1e-9), 0.0), 1.0)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- per-class facade
# u, v run 0..1 across one cell. One storey and one structural bay per cell, tiled at runtime.
def facade(cls, u, v):
    """-> (albedo rgb, height 0..1, roughness 0..1)"""
    # sill and head of the window opening within the storey
    if cls == 0:                                   # commercial: continuous glazing band
        win = smoothstep(0.175, 0.19, v) * (1 - smoothstep(0.815, 0.83, v))
        mull = 1 - smoothstep(0.03, 0.06, abs(u - 0.5) - 0.40)
        glass = win * (1 - (1 - smoothstep(0.06, 0.09, min(u, 1 - u))))
        glass = win if min(u, 1 - u) > 0.07 else 0.0
        base = (0.62, 0.63, 0.63)
        if glass > 0.5:
            tone = 0.20 + 0.13 * fbm(u * 9, v * 14, 11)
            rgb = (tone * 0.72, tone * 0.86, tone * 0.98)   # cool glass
            return rgb, 0.30, 0.10
        grime = 0.05 * fbm(u * 26, v * 26, 3)
        m = 1.0 - mull * 0.15
        return (base[0] * m - grime, base[1] * m - grime, base[2] * m - grime), 0.86, 0.42

    if cls == 1:                                   # government: sandstone ashlar
        course = abs(((v * 3.0) % 1.0) - 0.5)      # three courses per storey
        joint = 1 - smoothstep(0.44, 0.485, course)
        vjoint = 1 - smoothstep(0.44, 0.485, abs(((u * 2.0 + (0.5 if int(v * 3) % 2 else 0.0)) % 1.0) - 0.5))
        win = smoothstep(0.235, 0.25, v) * (1 - smoothstep(0.735, 0.75, v)) \
              * smoothstep(0.315, 0.33, u) * (1 - smoothstep(0.675, 0.69, u))
        if win > 0.5:
            return (0.13, 0.12, 0.12), 0.10, 0.55  # deep-set, in shadow
        stone = 0.60 + 0.075 * fbm(u * 34, v * 34, 7)
        rgb = (stone * 1.00, stone * 0.80, stone * 0.62)     # Dholpur sandstone
        h = 0.92 - max(joint, vjoint) * 0.34
        rgb = (rgb[0] * (1 - max(joint, vjoint) * 0.10),
               rgb[1] * (1 - max(joint, vjoint) * 0.10),
               rgb[2] * (1 - max(joint, vjoint) * 0.10))
        return rgb, h, 0.78 + 0.10 * fbm(u * 40, v * 40, 13)

    if cls == 2:                                   # residential: plaster, punched windows
        win = smoothstep(0.275, 0.29, v) * (1 - smoothstep(0.715, 0.73, v)) \
              * smoothstep(0.355, 0.37, u) * (1 - smoothstep(0.635, 0.65, u))
        if win > 0.5:
            return (0.16, 0.17, 0.18), 0.16, 0.30
        # staining below the sill, which is the most characteristic wear on Delhi plaster
        below = smoothstep(0.26, 0.10, v) * smoothstep(0.30, 0.40, u) * (1 - smoothstep(0.60, 0.70, u))
        streak = below * (0.35 + 0.65 * fbm(u * 46, v * 7, 17))
        base = 0.70 + 0.06 * fbm(u * 30, v * 30, 5)
        wash = base - streak * 0.22
        sill = 1 - smoothstep(0.02, 0.04, abs(v - 0.26))
        h = 0.90 + sill * 0.10
        return (wash * 1.00, wash * 0.96, wash * 0.90), h, 0.72 + streak * 0.12

    # cls 3: retail / mixed — shopfront at the base, plaster above
    if v < 0.42:
        glass = smoothstep(0.06, 0.09, min(u, 1 - u)) * smoothstep(0.05, 0.08, v)
        if glass > 0.5:
            tone = 0.22 + 0.17 * fbm(u * 11, v * 16, 23)
            return (tone * 0.90, tone * 0.88, tone * 0.80), 0.28, 0.14
        return (0.34, 0.31, 0.29), 0.88, 0.46
    win = smoothstep(0.575, 0.59, v) * (1 - smoothstep(0.855, 0.87, v)) \
          * smoothstep(0.335, 0.35, u) * (1 - smoothstep(0.655, 0.67, u))
    if win > 0.5:
        return (0.15, 0.16, 0.17), 0.16, 0.30
    base = 0.66 + 0.07 * fbm(u * 28, v * 28, 29)
    return (base, base * 0.95, base * 0.88), 0.90, 0.70


t0 = time.time()
print(f"  generating {SIZE_X}x{SIZE_Y} strip atlas ({CELL}px cells)…")

# height first: the normal map is derived from it, so it has to exist for the whole atlas
height = [0.0] * (SIZE_X * SIZE_Y)
albedo = [0.0] * (SIZE_X * SIZE_Y * 4)
rough = [0.0] * (SIZE_X * SIZE_Y * 4)

for py in range(SIZE_Y):
    v = py / (SIZE_Y - 1)
    for px in range(SIZE_X):
        cls = px // CELL
        u = (px % CELL) / (CELL - 1)
        rgb, h, r = facade(cls, u, v)
        i = py * SIZE_X + px
        height[i] = h
        o = i * 4
        albedo[o] = max(min(rgb[0], 1.0), 0.0)
        albedo[o + 1] = max(min(rgb[1], 1.0), 0.0)
        albedo[o + 2] = max(min(rgb[2], 1.0), 0.0)
        albedo[o + 3] = 1.0
        rough[o] = rough[o + 1] = rough[o + 2] = max(min(r, 1.0), 0.0)
        rough[o + 3] = 1.0

# normal from the height field. Sobel within the cell only — sampling across a cell boundary
# would bleed one class's geometry into another's edge.
normal = [0.0] * (SIZE_X * SIZE_Y * 4)
STRENGTH = 3.4
for py in range(SIZE_Y):
    for px in range(SIZE_X):
        # clamp inside the cell: a Sobel across a cell edge bleeds one class's geometry into the
        # next one's seam
        c = px // CELL
        cxl, cxh = c * CELL, (c + 1) * CELL - 1
        xm = max(px - 1, cxl); xp = min(px + 1, cxh)
        ym = max(py - 1, 0); yp = min(py + 1, SIZE_Y - 1)
        dx = (height[py * SIZE_X + xp] - height[py * SIZE_X + xm]) * STRENGTH
        dy = (height[yp * SIZE_X + px] - height[ym * SIZE_X + px]) * STRENGTH
        L = math.sqrt(dx * dx + dy * dy + 1.0)
        o = (py * SIZE_X + px) * 4
        normal[o] = (-dx / L) * 0.5 + 0.5
        normal[o + 1] = (-dy / L) * 0.5 + 0.5
        normal[o + 2] = (1.0 / L) * 0.5 + 0.5
        normal[o + 3] = 1.0


def save(name, flat, colorspace):
    # Order matters: set the colour space BEFORE writing pixels. Setting it afterwards
    # reinterprets a buffer that already holds values and the first attempt saved pure black.
    img = bpy.data.images.new(name, SIZE_X, SIZE_Y, alpha=True, float_buffer=True)
    img.colorspace_settings.name = colorspace
    img.pixels.foreach_set(flat)
    img.update()
    # verify the buffer actually took the data, rather than trusting that it did
    probe = list(img.pixels[:3])
    lo = min(flat[0::4]); hi = max(flat[0::4])
    mean = sum(flat[0::4]) / (SIZE_X * SIZE_Y)
    print(f"    {name}: source R range {lo:.3f}..{hi:.3f} mean {mean:.3f}; "
          f"buffer first px {[round(v, 3) for v in probe]}")
    if hi - lo < 1e-4:
        raise SystemExit(f"{name}: generated data is uniform, which is a bug in facade()")
    img.filepath_raw = os.path.abspath(os.path.join(OUT, f"{name}.png"))
    img.file_format = "PNG"
    img.save()
    return os.path.getsize(img.filepath_raw)


# albedo is colour and must round-trip through sRGB; normal and roughness are data and must not
sizes = {
    "facade-albedo": save("facade-albedo", albedo, "sRGB"),
    "facade-normal": save("facade-normal", normal, "Non-Color"),
    "facade-rough": save("facade-rough", rough, "Non-Color"),
}

report = {
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    "blender": bpy.app.version_string,
    "seconds": round(time.time() - t0, 1),
    "atlas": {"size_x": SIZE_X, "size_y": SIZE_Y, "cell": CELL, "layout": "4x1 strip",
              "uv": "u = (cls + fract(bay)) / 4 ; v = fract(storey). A strip has no vertical cell "
                    "boundary, so the atlas cannot be sampled upside down."},
    "cells": {
        "0": "commercial / office — glazing bands, mullions",
        "1": "government / civic — sandstone ashlar, deep-set windows",
        "2": "residential — plaster, punched windows, sill staining",
        "3": "retail / mixed — shopfront base, plaster above",
    },
    "files": sizes,
    "total_bytes": sum(sizes.values()),
    "provenance": "Entirely generated. No photographic source was used, because the data register "
                  "forbids redistributing imagery this project does not hold rights to (D12). The "
                  "cells are keyed to OSM building classes, so the texture carries information as "
                  "well as detail.",
}
json.dump(report, open(A["report"], "w"), indent=2)
print(f"  {SIZE_X}x{SIZE_Y} atlas in {report['seconds']}s — "
      + ", ".join(f"{k} {v/1024:.0f} KB" for k, v in sizes.items()))
print(f"  total {report['total_bytes']/1024:.0f} KB")
