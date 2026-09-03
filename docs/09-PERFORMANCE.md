# 09 — Performance: three measured reversals

The visual upgrade began with a plan I was confident about. Instrumentation overturned it three
times in a row, and each reversal is more useful than the plan was.

## The plan, and why it was wrong

I proposed: fix frustum culling, then spend the frame budget on screen-space ambient occlusion.
The reasoning was that CPU frame time read **1.4 ms of a 33 ms budget**, so there was 20× headroom.

That number was measuring the wrong thing. Every effect worth adding — AO, anti-aliasing,
reflections — is **fragment** work, and fragment work has nothing to do with how long JavaScript
takes. The first thing built was therefore a GPU timer, not an effect.

## Reversal 1 — "42 draw calls" was the bug, not the triumph

Each layer was merged into a single mesh spanning the whole 4 km box. A mesh that large is never
outside the frustum, so **every close-up view paid for the entire city**. The tile grid had existed
in config since Spike-0 and had only ever been used as a lookup key.

Splitting buildings, ground and trees into per-tile meshes made culling work: submitted triangles
at street level fell from 794 k to 535 k.

**And GPU time got worse — 8.1 → 20.8 ms.** I had traded triangles for draw calls, on a driver
where draw calls were dearer. Which led straight to:

## Reversal 2 — the measurement itself was unreliable

The A/B said *removing 460 k triangles made the scene slower*, which is physically impossible. Two
faults, both mine:

- the timer kept a rolling **mean that I never reset**, so a reading spanned the change being
  measured and blended both answers;
- the camera was still flying, so the frustum kept changing what was submitted.

A benchmark that parks the camera, resets the timer, collects a fixed sample count and reports the
**median** produced monotonic numbers immediately. Nothing before that was worth acting on.

> An unreliable measurement is worse than no measurement: no measurement leaves you cautious, a
> bad one makes you confident and wrong.

## Reversal 3 — the shadow map was 73% of GPU time

With a trustworthy benchmark, one A/B settled it:

| config | GPU median |
|---|---|
| close, everything on | 14.85 ms |
| close, trees off | 13.80 ms |
| **close, shadows off** | **3.73 ms** |

Trees — 17,360 instances, the thing I had assumed was expensive — cost **1 ms**. The shadow map
cost **10.1 ms**, more than the entire rest of the scene. And I had caused it: I raised the map
from 2048 to 4096 earlier for quality, turning it into 16.7 M texels re-rendered every frame.

The fix is not a smaller map. **The sun only moves when the clock moves, and the casters —
buildings, trees, landmarks — never move at all.** So the map is rendered on demand:
`shadowMap.autoUpdate = false`, with `needsUpdate` set in `setTime`. Moving vehicles were dropped
as casters, since a 4 m car's shadow is invisible at city scale and moving casters are the only
thing that would force a per-frame re-render.

Close-view GPU went **14.85 → 4.63 ms**.

Then, because the cost is now paid once per sun position rather than per frame, resolution became
nearly free: the map went to **8192** — 0.53 m per texel, sharp enough for parapets and tree
canopies. That would have been unthinkable at 10 ms a frame.

## Reversal 4 — screen-space AO is unaffordable, so AO got baked

AO was the centrepiece of the plan. Measured:

| config | GPU median |
|---|---|
| no post | 7.7 ms close · 10.8 ms wide |
| GTAO at half resolution | 26.2 ms |
| GTAO at 0.6 resolution | 33.2 ms |

Roughly **18 ms**, and it doubles submitted geometry because `GTAOPass` runs its own depth-normal
prepass over the whole scene. It does not fit, and a Retina display is four times the pixels again.

So the AO is **baked in Blender instead** — a top-down sky-visibility render of the whole massing
(`40_bake_city_ao.py`), sampled as a planar texture on the horizontal surfaces. Free every frame,
and *better* quality, because a bake is not limited to what happens to be on screen.

Two things that bake had to get right:

- **Occluders must be black.** The first attempt made them white; they bounced sky light back onto
  the ground and filled in the very occlusion being measured. The result was 97% white with thin
  halos. Black occluders only block.
- **It is not applied to walls.** The bake renders occluders dark, so a UV taken at a wall's base
  lands on that building's own roof and the wall goes near-black. Ground, roads, footways and
  plazas only.

Value distribution after the fix: p25 = 0.88, p50 = 0.98, floor 0.12 — real gradient in the street
canyons, which is what grounds the buildings.

Screen-space AO survives as an opt-in `high` tier, with its 33 ms cost stated in the menu.

## And a fake feature the gate caught

`QUALITY_NOTES` described a difference between `low` and `medium` that **did not exist in the
code** — both were identical. The QA gate found it by asserting `low` was cheaper and discovering
it was not.

Documentation claiming a capability the build does not have is worse than a missing feature. The
tiers now differ in something real, and the profiler said what: `low` drops shadows, which is the
single largest saving available.

## Where it landed

| | GPU median | |
|---|---|---|
| low | **3.1 ms** | no shadows, no post, baked AO, MSAA |
| medium | **4.4–7.7 ms** | on-demand 8192 shadows, baked AO, MSAA — default |
| high | ~33 ms | adds screen-space GTAO + SMAA, for still frames |

Wide-view GPU went from **19.1 ms to 6.5–7.7 ms** while *gaining* baked AO, an 8192 shadow map,
water reflections and working frustum culling.

`make qa` now asserts the GPU budget at a parked camera, and that each tier is measurably cheaper
than the one above it. It also prints the pixel load and warns when `devicePixelRatio` is 1, because
a headless pass is necessary and not sufficient — the real display is four times the fragments.

## The rule worth keeping

Every one of these was a case of optimising something I had not measured, on the strength of a
number that was measuring something else. The order that works:

1. instrument the resource you actually intend to spend;
2. verify the instrument produces monotonic results on a change whose sign you already know;
3. only then choose what to optimise.
