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

---

# Part three: the detail pass

The scene worked but read as a diagram. Fourteen layers now, **60 fps · 38 draw calls · 762,528
triangles · 0.88 MB gzip** including the bundle, and 106 data invariants.

## What was actually missing

Not polish. Three specific absences, each with a data answer:

**Buses cut straight lines between stops.** `CatmullRomCurve3` through stop positions drives through
buildings and rounds every corner. The fix was data, not code: OSM route relations list the actual
ways each route traverses, and the first extract only asked for member *refs* (`out body`), not
their geometry. `fetch_detail.py` now pulls `out geom` for the three selected relations and
`detail.route_paths` stitches the member ways in relation order, flipping each so its start meets
the running end. Routes 73, 604 and 281 now follow 5.9 km, 4.5 km and 5.1 km of real road.

**Nothing moved except buses.** A corridor coloured red with no vehicles on it asks the viewer to
take the colour on faith. Now the same estimate is drawn twice.

**No trees.** Lutyens' Delhi *is* its avenues, and 16 km² of it with 1,171 surveyed trees will never
read as this city. See the honesty note below.

## Vehicles: bunching for free, and still deterministic

The naive approach integrates position per frame, which drifts and is not reproducible. Instead
`traffic.ts` releases vehicles at a fixed **time** headway and recovers distance by inverting the
cumulative travel-time table along the spine:

    time[i] = time[i-1] + (dist[i] - dist[i-1]) / speed(segment i)
    distance(t) = invert(time, t)          // binary search + lerp

Three properties fall out of that, none of which had to be coded:

- Vehicles **bunch where the estimate says the corridor is slow**, because equal time steps are
  unequal distance steps.
- The **count rises with congestion** — slots are `total_time / headway` — so the number in the
  masthead is the estimate being drawn, not a demand figure. The provenance says exactly that.
- It stays a **pure function of the clock**, so scrubbing time is reproducible.

Buses use the same inversion, with an 18-second dwell added at every mapped stop, so they visibly
stop rather than gliding through. Stops are projected onto the path and any stop further than 70 m
from it is ignored as not really on this route.

## Trees: the one place this project generates data

1,171 of the 17,360 trees are surveyed OSM records. **16,189 are generated** at fixed spacing along
main-road edges. That is a real line to cross, so:

- they are counted separately in the payload and the build report;
- the layer reports `mode: simulated` **because of them**, not despite them;
- the provenance states that no individual generated tree corresponds to a real tree;
- generation skips within 9 m of an observed tree, so the two never double up;
- a data invariant now fails the build if that disclosure goes missing from the provenance.

The same reasoning covers rooftop parapets and water tanks: OSM has no usable roof detail here (263
of 290 `roof:shape` tags say `flat`), a flat-topped prism is the single thing that makes procedural
massing look like a toy, and what is actually on a Delhi roof is a parapet and a black polymer tank.
So they are generated, declared `simulated`, and the layer says no individual tank is a real tank.

## The bug that made three layers black

Trees, cars and water tanks all rendered black. All three set `vertexColors: true` **and** supplied
an `instanceColor`, on geometries with no `color` attribute:

    #elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
        vColor = vec3( 1.0 );
    #endif
    #ifdef USE_COLOR
        vColor *= vertexColor;      // attribute absent -> WebGL supplies (0,0,0)
    #endif
    #ifdef USE_INSTANCING_COLOR
        vColor.xyz *= instanceColor.xyz;
    #endif

`vertexColors` declares `USE_COLOR`, the missing attribute reads as zero, and every instance is
multiplied to black. `instanceColor` needs no help — setting `vertexColors` alongside it on a
geometry that has no colours is what breaks it.

> **When you add an instanced layer:** per-instance colour comes from `instanceColor` alone. Set
> `vertexColors` only when the geometry genuinely carries a `color` attribute — which, in this
> codebase, means it came out of `geom.ts`'s `finish()`.

## Shadow budget, measured not assumed

17,360 tree instances in the shadow pass was the one place this scene could plausibly have run out
of frame time. Measured: still 60 fps, so canopies cast. Dappled avenue shade is what grounds them;
without it 17k trees look pasted onto the ground.

---

# Part four: metro, night and people

Sixteen layers. **60 fps · 41 draw calls · 816,874 triangles · 0.88 MB gzip**, 130 data invariants.
The masthead reads *"326 vehicles · 12 buses · 20 trains · 2200 walking"*.

## The metro is underground, so that is where it is drawn

The obvious implementation puts trains on the line trace at ground level. That would be a plain
factual error here: of the 19 subway ways inside this box, **13 are `tunnel=yes`**, 4 are bridge and
2 surface. Central Delhi's metro is in tunnel.

So the trace and its trains sit at **−11 m** and are drawn as an X-ray over the city —
`depthTest: false` at low opacity, which is the established map idiom for something beneath the
surface. It reads unmistakably as *under* rather than *on*, which is the accurate reading.

Colours are DMRC's own, straight off the OSM route relations: Blue `#4169E1`, Yellow `#FFDF00`,
Violet `#553592`, Airport Express `#FF8C00`. The legend names each one "(in tunnel)".

Trains use the same time-inversion as the buses and the corridor vehicles, with a 25-second station
dwell, so they stop where the stations are. One tunnel depth is used for every line, which the
provenance says — real depths vary and Rajiv Chowk's interchange is deeper.

## The day/night model was broken, and it took a night render to notice

`setTime` mapped 05:00–19:00 onto a half sine and **clamped outside it**. Every hour from 19:00 to
05:00 therefore produced identical output: a permanent sunset, brown sky, sun on the horizon. There
was no night at all, and nothing failed — the scene simply stopped changing.

It now runs a **signed** elevation: positive through the day, negative after dark, with dusk as a
crossing rather than an endpoint. Sunrise and sunset are Delhi in early September.

Windows come on from that same elevation, through a shared `FACADE_UNIFORMS.uNight` — so one write
lights the whole city, and it is the clock that decides, not a separate switch. Each window is a
hash of its own bay-and-storey cell, so the pattern is scattered but identical on every reload;
ground floors stay lit later than upper storeys, because shopfronts do.

## Where "accurate" and "readable" pulled against each other

First night render was almost black: correct, and useless. The city was a field of floating windows
with no ground, no roads, no shape.

The resolution is not a fudge. **Delhi's skyglow is considerable and its main roads are lit**, so a
dim, sodium-lit street network is *closer* to the truth than a black one. Roads now carry a warm
emissive pooled along their length so it reads as lamps rather than a glowing strip, and the
hemisphere light keeps a night floor. An unreadable city is not a more honest city.

## People: observed paths, assumed people

926 mapped footways, 2,200 walkers on them. The paths are observed OSM geometry; **the people are
not, and no footfall data was used anywhere in this product.** Density is a declared assumption of
one walker per 26 m of path, pace 1.1–1.6 m/s, and the provenance says outright that the numbers do
not vary with time of day and nothing here should be read as when or where people actually walk.

Walkers reverse at the end of a path rather than teleporting to the start, and position is a pure
function of the clock, so scrubbing time stays reproducible — the same property the buses, trains
and corridor vehicles all have.

## One more, on writing the test before believing it

The metro invariant I added asserted a path had more than 5 vertices — and it failed immediately on
the Airport Express Line, which runs almost straight through the box and legitimately simplifies to
5 points. Vertex count was never the property worth asserting; **length** is, and that check was
already there. I committed with it red, which should not have happened: the gate exists to be run
before the commit, not after.
