# 07 — Render correctness: the rules every new layer must follow

Found on 2026-09-03 — most by auditing the geometry before its first run, the worst one by looking
at the render afterwards. Several of these produce a city that is **invisible or unlit with nothing
in the console**, which is the worst class of bug: it looks like a data problem and sends you back
through the pipeline hunting for data that was there all along.

Recording them here because they are not one-off fixes. Every future layer builds geometry the same
way and will hit the same traps.

## Rule 1 — Winding decides visibility, so normalise every ring

All ground-plane geometry is built in the XZ plane, and materials are front-side by default. A
back-facing triangle is not dim, it is **gone**.

For a triangle to face **+Y (up)** in Three's right-handed space, its vertices must run *clockwise*
when plotted with x right and z up — that is, with a **negative shoelace area**. Worked through:

    ring  (0,0) → (0,1) → (1,0)
    shoelace = (0·1−0·0) + (0·0−1·1) + (1·0−0·0) = −1        → negative
    a=(0,y,0)  b=(0,y,1)  c=(1,y,0)
    (b−a)×(c−a) = (0,0,1)×(1,0,0) = (0,1,0)                  → up ✓

OSM rings arrive in **either** winding, so `orient()` in
[`web/src/layers/geom.ts`](../web/src/layers/geom.ts) normalises every ring to negative signed area.
That fixes the hand-built **wall quads**.

### It does not fix triangulated faces — and assuming it did cost a whole render pass

`THREE.ShapeUtils.triangulateShape` is earcut, and earcut **does not preserve the input winding**.
It normalises internally and always emits triangles facing −Y in this plane. Measured against
three r169 rather than assumed:

    CCW input (shoelace +1)  ->  both triangles face -Y
    CW  input (shoelace -1)  ->  both triangles face -Y

So the triangle order is reversed once, inside `fanIndices`, for every consumer. Before that fix
**every ground polygon, water area, plaza and building roof pointed at the floor.** The scene still
looked plausible, because buildings render their walls — so the symptom was "the parks are missing",
which sends you hunting through the pipeline for data that was there all along.

The first version of this document confidently stated the opposite, and the render was the thing
that corrected it.

> **When you add a layer:** rings through `orient()` for anything you extrude by hand; anything
> triangulated goes through `fanIndices`, never `ShapeUtils` directly. And check a render — a
> back-facing surface throws no error and logs nothing.

## Rule 2 — Never hand-author a normal

The original wall code set each vertex normal to `(dz, 0, −dx)`, while the face winding produced a
geometric normal of `(−dz, 0, dx)` — **exactly opposite**. The walls would have been lit from
inside: a city in permanent shadow, which reads as "the sun isn't working".

Every vertex in this geometry is unshared (each wall quad owns its four vertices), so
`computeVertexNormals()` yields exact flat normals that cannot disagree with the winding. `finish()`
does this centrally and there is no path that writes a `normal` attribute by hand.

> **When you add a layer:** build positions and colours, then let `finish()` compute normals.

## Rule 3 — Ribbon triangles have exactly one correct order

The intuitive index order for a triangle strip faces **down**. Verified for a segment running +X,
with `left = p + (dz, −dx)·half`:

    l0=(0,y,−1)  r0=(0,y,1)  l1=(1,y,−1)  r1=(1,y,1)

    (l0, r0, l1):  (0,0,2)×(1,0,0)  = (0, 2, 0)   → up ✓
    (r0, r1, l1):  (1,0,0)×(1,0,−2) = (0, 2, 0)   → up ✓

    (l0, l1, r0):  faces the ground — renders nothing

Roads, rail, water lines and corridor overlays all go through `ribbons()`, so all four were affected
by the same single mistake.

## Rule 4 — Say which colour space you mean

Three's working colour space is **linear-sRGB**. `Color.setRGB` and `Color.setHSL` interpret their
arguments in the working space unless a colour space is passed, while the `Color(0xRRGGBB)`
constructor converts *from* sRGB automatically. So hex literals are safe and hand-tuned RGB/HSL
triples are not: the sun went muddy and the sky desaturated because
[`stage.ts`](../web/src/core/stage.ts) built them without saying `THREE.SRGBColorSpace`.

Vertex colours are a different case and were already right: they come from
`new THREE.Color(hex)`, which means they are already linear, which is what a buffer attribute wants.

> **When you add a layer:** hex constructor for palette colours; explicit `THREE.SRGBColorSpace` for
> any `setRGB` / `setHSL`; `getHexString()` for CSS (it returns sRGB by default).

## Rule 5 — Y ordering on a flat plane is a shared budget

Everything analytical lives within about 1 m of y = 0, so the stack has to be written down or layers
silently eat each other. Water was originally at y = −0.20, inside the ground-cover band, so a lawn
polygon could paint over a lake.

| y | Layer |
|---|---|
| −0.35 | base plate (fills gaps in OSM landuse so they read as ground, not void) |
| −0.30 … −0.14 | ground cover, largest polygon first; the step is **normalised by polygon count**, because clipping splits polygons and a fixed step let a big enough dataset climb out of the band |
| −0.10 | landmark plazas (`kind: open`) |
| **−0.08 / −0.06** | water areas / waterway lines — **must clear the ground band** |
| +0.012 … +0.03 | road kerb casing, then the carriageway on top, both stacked by class |
| +0.16 | rail and metro |
| +0.55 | corridor traffic overlay |
| 0 … h | buildings and landmark massing |
| +1.6 / +3.5 | station and bus-stop markers |

## Rule 6 — Feature indices outgrew `Uint16Array`

`vertexFeature` maps a vertex back to its entity so a raycast hit resolves to something
inspectable. It was `Uint16Array`, which caps at 65,535 — fine for today's 3,203 buildings and
~1,900 road segments, but a silent wraparound the moment the box or the road filter grows, and the
symptom would be *the wrong building's details in the drawer*. Now `Uint32Array`. The memory cost at
current scale is about 180 KB.

## Rule 7 — A failed layer must not crash a panel

`scenarioLab` indexed `corridors[0]` unconditionally. If `corridors.json` had 404'd, the Scenario
Lab would have thrown during render and taken the whole app with it — defeating FR-01, the
requirement that layers fail independently. It now renders an explicit unavailable state.

> **When you add a panel:** the empty and failed cases are part of the design, not error handling
> bolted on afterwards. Test by deleting files from `web/public/data/@v1/`.

## Two more, smaller

- **Bus orientation.** `Matrix4.lookAt` aligns an object's −Z with the target, but the bus box is
  11 m along its own **X**. Every bus would have driven sideways. Now `makeBasis(tan, up, tan×up)`.
- **Playback wrap.** The clock wrapped modulo 1440 while the time slider spans 240…1400, so
  playback could park the clock at a value the control could not represent. It now wraps inside the
  control's own window.

## Verified

All of the above now runs. Measured on the primary benchmark device (Apple M1 / 8 GB, Chrome):
**60 fps, 14 draw calls, 80,663 triangles, 0.71 MB gzip including the bundle**, 90/90 data
invariants, and FR-01 confirmed by deleting `corridors.json` and `ground.json` from the build — the
app stayed up at 60 fps with the other seven layers, the Scenario Lab showed its unavailable state,
and Data Status named both failures.

Worth noting what the hand audit did and did not catch. Working the vector algebra by hand found six
of these outright. It did **not** catch the earcut winding, because that one depended on a library's
actual behaviour rather than on arithmetic — only the render found it. Static reasoning and a
screenshot catch different classes of bug, and this project needed both.


---

# Part two: the visual pass

Materials and lighting only — no geometry, data, metric or copy changes. Measured after: **60 fps,
14 draw calls, 80,663 triangles, 0.71 MB gzip.**

## Shadows were switched off on an assumption, not a measurement

The original comment read *"3,203 buildings; shadows are not worth the frame time"*. The scene is
76k triangles in 13 draw calls, so one directional shadow map costs almost nothing here, and it is
the single biggest realism gain available — without contact shadows a city reads as a tabletop
model. 2048 over the whole 4 km box gives 2.5 m per shadow texel, which is technically shadows and
visually nothing; **4096 over a box tightened to ±2166 m** gives about 1 m, which is the scale of
the thing casting them.

## No textures, by design — so the detail is procedural

The data register forbids redistributing landmark imagery, and a texture atlas for 3,203 buildings
would blow the transfer budget the whole pipeline was tuned around. So
[`facade.ts`](../web/src/layers/facade.ts) generates storey lines, window bays, a darker ground-floor
plinth and gravel roof tone in the shader from world position. Zero bytes, zero draw calls.

Two rules it follows:

- **It modulates `diffuseColor`, never replaces it.** Everything the vertex colours encode still
  shows through: the observed/estimated reveal, corridor traffic state, selection highlight. A
  shader that overwrote the colour would have silently disabled the honesty features.
- **It fades with distance.** A 1-metre window rhythm across a 4 km box is a moiré generator, so
  the pattern dissolves between 900 m and 2600 m.

## Where the visual pass had to stop short of the honesty features

Buildings get a deterministic hash-based tone spread, split into a cooler concrete family and a
warmer plaster/sandstone one, because a single hue is the tell that massing was generated. But when
**Reveal estimated heights** is on, only brightness varies and hue is pinned. The user is asking
"which of these heights did you guess?" — blurring sage against amber to make the street prettier
would trade the one distinction that has to be exact for decoration.

## Other changes

| Change | Why |
|---|---|
| Sky dome with horizon gradient, sun glow and a haze band | A flat background colour is what makes a 3D scene look like a screenshot of one. One draw call. |
| Horizon hue moved off 0.14 | 0.14 is yellow-green and turned the whole sky olive. Delhi's haze is a warm neutral, so the horizon is barely saturated and the zenith carries the blue. |
| Kerb casing under every road | A wider, darker ribbon beneath each carriageway. The cheapest thing that stops a road network reading as coloured tape on a plane. |
| Asphalt darkens with road class | Hierarchy reads without labels. |
| Low-frequency noise on ground cover | 489 flat polygons in four colours read as vector art. A lawn is not one colour. |
| Dim opposite-side fill light | North faces were flat black rather than shaped. |

## QA render script bugs worth remembering

Both produced a **flat grey frame with no error of any kind**:

- **Blender's default camera clips at 100 m.** This scene is kilometres across. Every early QA sheet
  was empty because the geometry sat beyond the far plane.
- **Hand-rolled look-at Euler angles.** A Blender camera looks down its local −Z, and a sign error
  aims it at nothing. Now `direction.to_track_quat("-Z", "Y")`, which is Blender's own.
