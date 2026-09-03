# 10 — Reach on foot, and what route choice is actually worth

Tier 2 of the visual/utility push. Two of the three items here turned out to be about honesty
rather than graphics, and one of them produced a negative result worth more than the feature it
was meant to justify.

---

## 1. The walking graph

Everything before this described a **corridor** — a line. The question a resident actually asks is
about an **area**: *what can I get to from here, on foot, in the time I have?*

Built at runtime from geometry the scene has already loaded — 684 OSM road ways and 926 footway
ways — so it costs one pass over arrays in memory and **no new download**. Built lazily on first
use; most sessions never open the panel.

`src/analysis/network.ts`

| | |
|---|---|
| nodes | 5,164 |
| edges | 5,795 |
| walking speed | 4.8 km/h declared (80 m/min) |
| stepped ways | 1.6 km/h declared, 110 edges |
| largest connected component | **85.8%**, 63 components |

### The fragmentation bug, and why it mattered

The first version matched way endpoints **vertex to vertex** within 2 m. Result: **45.4%** of nodes
in the largest component, 474 components. It rendered perfectly and every answer was wrong — a
15-minute walk from Connaught Place reached 0.82 km² instead of 1.81, 20 mapped places instead of
45, one metro station instead of three.

The cause is structural, not a bug in the tolerance. OSM maps sidewalks as their own ways that end
**at the kerb**, not at a vertex of the carriageway. Road vertices sit ~40 m apart, so a footway
ending 5 m from the carriageway can be 20 m from the nearest road *vertex*.

The fix is to **project onto the nearest segment and split it**, for every way end of degree 1 —
precisely the signature of a way drawn up to something it is not joined to. Snapping to a
segment's endpoint alone cannot make a T-junction work; the split can.

Measured sensitivity, because a threshold that decides the answer is a result, not a threshold:

| tolerance | 8 m | 12 m | 15 m | 18 m | 22 m | 28 m |
|---|---|---|---|---|---|---|
| largest component | 82.1% | 84.9% | **85.7%** | 86.2% | 86.5% | 86.6% |

A 4.5-point spread across a 3.5× range. The connectivity comes from the projection, not from a
generous threshold. 15 m is used, which is roughly a sidewalk-to-centreline distance on a wide
Delhi carriageway — the gap being closed is physically real: you step off the kerb.

**A starting point that lands on a small component is named as such.** Below 250 nodes the panel
leads with a warning that the answer is a property of the OSM data and not of the city, because
otherwise clicking the wrong spot returns "0.04 km²" with the authority of every other figure.

---

## 2. Four questions the field answers

`src/analysis/reach.ts`, `src/layers/reach.ts`, `src/ui/reachPanel.ts`

1. **Walk from a point** — isochrone bands at 5-minute steps to 25.
2. **Step-free penalty** — the same query with the 110 `highway=steps` ways removed.
3. **Walk to the metro** — multi-source from the 9 metro stations (`sub=true`; the two mainline
   halts are not what "walk to the metro" means).
4. **Walk to a bus stop** — multi-source from the 166 mapped stops.

Every share is reported against the **served area** — the 9.67 km² within 70 m of any mapped way —
and never against the 16.1 km² box, a third of which is lawn, carriageway island and walled
compound interior that no pedestrian network reaches.

### The step-free result is ~0%, and that is the finding

Measured across ten origins: the penalty ranges **0–2.6%**, and is 0.0% at most of them. So the
panel says so in those words — *"No steps on any shortest route from here. The 110 stepped ways
mapped in this box are almost never the only link between two points."* Hunting for a number to
report would have been the dishonest move.

### Two rendering decisions

**Map mode.** Depth-tested, the field is paint on the ground: correct, and unreadable from 1 km up
over Connaught Place, because the near bands fall in the thin gaps between buildings while the far
bands sit on the open Rajpath lawns. The brightest, most informative part of the field was hidden
under rooftops and the least informative part covered a third of the screen. So from above the
depth test is dropped and the field reads as a layer over the city — which is what an isochrone map
*is*. At street level the depth test comes back.

**The ramp runs bright-to-dim, not dark-to-light.** The first version put the deepest colour at
25 minutes, and on a city already in 08:30 shadow that band read as shadow rather than as
information. Near is where the answer is, so near is where the ink goes, and the field fades out
as the time runs out. Per-band alpha does the fading.

**One shader-level trap.** A raw `ShaderMaterial` gets none of the fragment chunks a
`MeshStandardMaterial` does, so `#include <colorspace_fragment>` is not optional: without it a
linear-converted ramp is written unconverted to an sRGB framebuffer and the overlay comes out
roughly half as bright as authored.

---

## 3. Can a cleaner route help? — a measured no

The idea: minimising **time** and minimising **inhaled dose** are different problems on the same
graph, and in a city where the arterial is both the fastest way and the dirtiest air, the
difference would be advice somebody could act on this afternoon.

Per-edge **kerbside enrichment** is a declared geometric heuristic: a near-road gradient decaying
with a 45 m length scale from a peak taken from the versioned exposure model's `in_traffic` figure
(1.20), scaled by road class as a proxy for traffic volume. Dijkstra then runs on
`Σ minutes × enrichment`, which is exactly proportional to inhaled mass when concentration and
ventilation are fixed — and they are.

One consistency check that was not arranged: a footway at a typical 9 m kerb offset from a
secondary road comes out at **1.164**, against the same model's independently declared flat
`walking_footway` figure of **1.15**.

### The artefact that had to be fixed first

The first version charged **road-derived edges a distance of zero** to their own traffic — a
pedestrian walking down the middle of the lane. Since the well-connected part of this graph *is*
the road network, every edge in it sat at the model's peak, and the lowest-dose route came back
identical to the quickest on four journeys out of five. Measured separately, footway edges spanned
1.00–1.20 with a median of 1.07, so the model discriminated fine; the geometry was charged wrongly.
`KERB_OFFSET` floors the distance at half a carriageway plus a kerb, by class.

### The result, after the fix

Over **149 random journeys** longer than 500 m:

| | |
|---|---|
| had a different lowest-dose route at all | 21 of 149 |
| median dose saving | **0.0%** |
| best saving found anywhere | **2.15%**, for 0.04 extra minutes |

So **route choice is not a lever for PM2.5 here**, and the UI says that rather than dressing a 0.3%
difference up as advice. The reason is physical, not a modelling artefact: PM2.5 in Delhi is
dominated by the regional background, so the kerbside increment is a small perturbation on a number
already several times the WHO guideline. A pollutant with a steeper roadside gradient — NO₂, black
carbon, ultrafines — would answer differently, and this model does not cover them.

The panel then points at the levers that **do** move the number, with the app's own magnitudes: the
hour you travel (the forecast scan regularly finds a 15%+ dip inside the working day) and the mode,
which sets duration and breathing rate. A tool that only ever finds a saving is a tool fitting the
answer it wants.

---

## 4. India Gate, and a fourth normals bug

The most-looked-at object in the scene was **506 triangles** — the smallest model in the set. Six
prisms and a dome read as a lump of stone with a hole in it from anywhere closer than 400 m.

What was missing was not polygons but the horizontal articulation that makes masonry read as
masonry: a stepped approach, a plinth with its own base moulding and drip, a string course at the
arch springing, a three-course cornice that projects far enough to throw a shadow line, a recessed
inscription band, and pilasters framing the panels on all four faces. Now **545 faces / 1,134
triangles at LOD0**, 85 KB against a 400 KB budget.

Built additively. The arch opening keeps its boolean — a triumphal arch without the opening is not
one — but nothing else does, because two separate non-manifold boolean failures on this exact model
already cost an afternoon and survived two rounds of "fixes" by silently returning the cutter's
shape.

### Three bugs a render caught and no number did

**The buildings layer was drawing a windowed office tower over it.** India Gate's arch is *also*
mapped in OSM as `way/1078065894`, a 40 m building distinct from the monument way the landmark
config names — so excluding landmark footprints by OSM id missed it entirely. Rashtrapati Bhavan
and the New Parliament had the same overlap, five duplicates in one case. The exclusion is now
**spatial** and lives in the pipeline (`landmark_polys`), with a data invariant that asserts no
building centroid falls inside an authored landmark ring. `kind=open` landmarks are exempt: Jantar
Mantar's enclosure contains the Samrat Yantra, a real masonry instrument that must keep rendering.

**A string course ran straight through the arch void.** At 0.93 of the footprint the band crossed
the opening and rendered a stone beam hanging in mid-air. It now exists only where there is masonry
to carry it — the two piers and the two narrow faces.

**Pilasters were coplanar with the pylon face**, which z-fought as a bright seam up the facade.
They now bite 0.15 m into it.

### The normals safety net

India Gate rendered near-black on its lit faces at 08:30 while the steps beside it — same material,
same joined mesh — rendered correctly. That turned out to be the sun angle, not normals. But
checking revealed that **nothing in the Blender chain ever verified normal orientation**, after
three separate normals bugs in this project (hand-authored walls opposite to their winding, earcut
emitting −Y regardless of input winding, ribbon triangles wound to face the floor). Every one of
them rendered without an error and was caught by looking at a picture.

`dptblend.orient_outward` now runs on every object at the single choke point every landmark passes
through. It is **not** `normals_make_consistent` alone, which only makes a mesh agree with itself
and can happily agree on inward: the signed volume of a closed mesh is positive exactly when its
normals face out, so it is measured with bmesh and flipped if wrong — no ray casting, no heuristic.
It runs per object *before* the join, because a joined mesh of interpenetrating shells has no single
well-defined outside. `footprint_solid` therefore closes the floor by default, which is what makes
the volume test exact; the floor of a monument on the ground is never visible.

---

## 5. A performance measurement I got wrong, and the harness change it forced

Adding the tier put the wide-view GPU gate over budget, so I went looking for the cause and
initially found a confident wrong answer.

The sequence: I built a git worktree at HEAD, measured it at the same camera, and got **12.9 ms**
against my build's **24.6 ms** at *identical* submitted geometry — 103 draw calls, 825,081
triangles either way. Same geometry, double the time, so I concluded it had to be shader cost and
went hunting through the material changes.

Then I ran the two builds **alternating in one pass**, which is the test I should have run first:

| pass | HEAD | this build |
|---|---|---|
| 1 | 25.2 ms | 23.3 ms |
| 2 | 21.4 ms | 41.3 ms |

HEAD now measured 21–25 ms, having measured 12.9 ms twenty minutes earlier. **The machine was the
variable, not the build.** My "decisive A/B" was two samples taken an hour apart and I read a
2× thermal drift as a code regression.

What survives is the measurement I *can* trust: deltas taken **back-to-back inside one browser
session at one parked camera**, which share thermal state as closely as anything can. Those said:

| layer removed | GPU saved | triangles removed |
|---|---|---|
| Street furniture | **4.4 ms** (2.7 ms on a repeat) | 139,380 |
| Trees | 2.6 ms | 520,800 |
| Rooftop detail | 10.6 ms | 129,474 |
| Facade textures (all three maps) | 1.2 ms | 0 |

Furniture costing more than 520,000 triangles of trees is the real finding, and it is not about
triangle count: **thousands of objects one or two pixels tall are the worst case for a rasteriser.**
Every triangle wastes most of its 2×2 quad and every instance still pays full vertex and shader
cost, and none of it resolves into anything a viewer can see.

### The LOD ladder, set around the default camera

`AltitudeGate` in `layers/registry.ts`. The thresholds are chosen **relative to the default camera,
which sits at 900 m** — that view is the first thing anyone sees and every gate that reads at that
scale must be open there.

| layer | drawn below | why that height |
|---|---|---|
| Street furniture | 420 m | lamp posts and shelters are street-level only |
| People on paths | 950 m | just past the default view: the masthead claims 2,200 people walking and the view it opens on had better show them |
| Rooftop detail | 1200 m | at 900 m a 1.8 m tank is still 2–3 px and the roofscape reads as texture |

The wide budget camera sits at 1400 m, further out than the default, so it drops all three.

**I got the first version of this wrong in the other direction.** The rooftop gate went in at
exactly 900 m, which silently stripped the roofscape out of the hero view. The saving was real and
the trade was wrong — a performance win that degrades the one view everybody sees is not a win.

Shadow receiving is dropped on furniture except shelter roofs, the only piece with a surface big
enough to read one. It is a LOD decision and not a data one: nothing is dropped from a report, a
count or a provenance record, and every layer stays listed with its real feature count.

Wide-view GPU went **33.1 → 19.4 ms** (stable, 1% repeat spread) on the rooftop and furniture gates
alone.

**The harness change.** Each camera is measured twice and the **lower** median is used. That is not
cherry-picking; it is the only defensible estimator, because throttling, another process on the GPU
and a second browser window can each only *add* time to a frame, never remove it — so of two
samples of the same work, the smaller is the better estimate of what the build costs. The repeat
spread is printed, and a spread above 25% raises a note that the absolute figure is an upper bound.
A gate that reads one sample turns a hot laptop into a code review comment.

### Where I stopped, and why

After the gates I tried one more isolation pass. It returned a 24.96 ms baseline for the build that
had measured 19.4 ms minutes earlier, and reported that **removing the footway layer made the frame
2.3 ms slower**. Removing geometry cannot make rendering faster; that reading is noise of ±2 ms on
a signal I was trying to read at 2–3 ms. So I stopped: optimising against those numbers would be
fitting noise, which is exactly the mistake at the top of this section.

The pedestrian gate went in anyway, on the geometric argument alone, and its docstring says
plainly that the saving is unquantified rather than quoting a figure from a bad run.

**The wide-view budget check is still red: 19.4 ms against a 16.7 ms budget.** I have not raised the
budget — it lives in the scope lock with `_measured` provenance and moving it to make a gate pass
would defeat the point of having it. The honest position is that this build is over budget on a
machine that demonstrably drifts 2× within a session, the *relative* improvements are sound, and the
absolute figure needs re-measuring on a cool device before either accepting it or cutting more
content. The close and street-level views are inside budget throughout.

---

## 6. Street furniture

3,761 pieces — lamp posts at 32–42 m by road class on alternating sides, a shelter at every mapped
stop, signal masts at inferred main-road junctions. Generated from geometry already in memory: no
new data file, no new fetch. Declared `simulated`, because OSM maps **14** street lamps in this
entire 16 km² box, so a survey was never on the table. The shelters over-state provision — many
real Delhi stops are a pole or nothing.

Worth building only because the street-level camera means someone can now get close enough to see
it.

---

## Where it leaves the numbers

| | |
|---|---|
| layers | 20 registered, 19 ready |
| data invariants | **154** |
| browser checks | **58** |
| GPU, street level | 2.6 ms |
| GPU wide | best-of-2 gated; see §5 — this machine drifts 2×, so absolutes need re-measuring cool |
| walking graph | 5,164 nodes, 85.8% connected, built lazily from data already loaded |
