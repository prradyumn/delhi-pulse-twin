# 07 — Render correctness: the rules every new layer must follow

Found by auditing the geometry code before its first run, on 2026-09-03. Four of these would have
produced a city that renders **invisible or unlit**, with no error in the console — the worst class
of bug, because it looks like a data problem and sends you back to the pipeline.

Recording them here because they are not one-off fixes: every future layer builds geometry the same
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
[`web/src/layers/geom.ts`](../web/src/layers/geom.ts) normalises every ring to negative signed area
before triangulation. `THREE.ShapeUtils.triangulateShape` (earcut) preserves the input winding, so
once the ring is oriented, **roofs face up and walls face outward for free** — no per-face reasoning
needed anywhere downstream.

> **When you add a layer:** pass rings through `orient()` first. Never assume source winding.

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
| −0.30 … −0.11 | ground cover, largest polygon first, stacked by 0.00035 so small gardens win |
| **−0.08 / −0.06** | water areas / waterway lines — **must clear the ground band** |
| +0.02 … +0.06 | roads, stacked by class so a primary reads over a service road |
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

## What is still unverified

None of this has been executed — see the blocker note in [`../README.md`](../README.md). These fixes
come from reading the code and working the vector algebra by hand, which catches sign and ordering
errors well and catches nothing about API drift, bundler behaviour or actual frame time. Expect a
further pass once `make check` can run.
