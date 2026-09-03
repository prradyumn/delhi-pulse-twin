# 06b — Spike-0 results

Run 3 September 2026. Overpass extract, Blender 5.2.0 LTS, Apple M1 / 8 GB.
**Verdict: GO on box A, with three scope changes forced by the data.**

## 1. OSM completeness audit — three candidate boxes

| Metric | **A · proposed** | B · shifted north | C · shifted east |
|---|---|---|---|
| Buildings | **3,445** | 4,135 | 2,033 |
| Height *or* levels tag | 9.4% | 10.4% | 9.3% |
| Highway ways (all / major) | 4,099 / 442 | 4,562 / 371 | 3,136 / 398 |
| Bus stops | 134 | 135 | 111 |
| Rail stations | 14 | 19 | 13 |
| Kartavya Path ways | **7** | 4 | 2 |
| India Gate present | **yes** | **no** | yes |
| Jantar Mantar / Rashtrapati Bhavan | **both** | Jantar only | neither |

**Box A wins and is now LOCKED.** B loses India Gate — the single most recognisable object in the
study area — and C loses both Jantar Mantar and Rashtrapati Bhavan.

### Deep audit of box A
- Actual extent **3,935 × 4,086 m = 16.08 km²**
- **UTM 43N origin (SW corner): 714875.97 E, 3166075.80 N** — committed to config
- 3,305 usable footprint polygons after validity repair (of 3,445 elements)
- **206 footprints/km², 13.7% footprint coverage** — see finding 1 below
- Height *or* levels tag on 271 polygons = **8.2%**. Levels: median 3, p90 13, max 26
- **landuse/leisure polygons cover 58.5% of the box** (grass 164, garden 80, park 54, pitch 38)
- Rough triangle total for every footprint extruded: **~96,000**

## 2. Transit — GTFS is blocked, OSM route relations replace it

`otd.delhi.gov.in/api/realtime/` returns **401** — confirms the PRD: realtime needs an authorised
key. Out of MVP as planned.

Static GTFS is **not** openly downloadable. The page at `/data/static/` is HTML behind a
*usage-declaration form* ("Usage Type: Commercial / Non-Commercial", "Purpose: Academia R&D /
Business / Journalism"), and the file host it references — `traffickarma.iiitd.edu.in:9010` — is
unreachable from here (connection refused on all of `agency.txt`, `stops.txt`, `routes.txt`,
`trips.txt`, `stop_times.txt`, `shapes.txt`). **This is a licensing decision, not a technical
blocker, so it is left for the owner to complete.**

**The replacement is better than a workaround.** OSM carries **210 bus route relations / 138 distinct
route refs** touching box A, operator Delhi Transport Corporation — real route numbers, real ordered
stop sequences, ODbL, and already licence-cleared as part of D1. So:

> **The transit layer ships without GTFS.** GTFS becomes a genuine V1.5 enhancement supplying
> *scheduled headways*, not an MVP dependency. Baseline headway becomes a declared scenario
> assumption, labelled as assumed rather than observed.

## 3. Corridor bus coverage — the finding that changed the scope

| Corridor | Distinct bus refs | Stops in 120 m | Chains | Longest chain |
|---|---|---|---|---|
| Baba Kharak Singh Marg | **75** | 7 | 4 | 1,047 m |
| Sansad Marg | 21 | 8 | 4 | 898 m |
| Janpath | 17 | **14** | 10 | 1,060 m |
| Ashoka Road | 17 | 8 | 10 | 641 m |
| Barakhamba Road | 15 | 6 | **2** | 1,078 m |
| Copernicus Marg | 8 | 3 | 2 | 1,039 m |
| Tolstoy Marg | 7 | 4 | 2 | 1,289 m |
| **Kartavya Path** | **0** | **0** | **1** | **2,346 m** |

**Kartavya Path carries no bus routes at all.** That is not a data gap — it is a ceremonial boulevard
and buses genuinely do not run on it. It is simultaneously the *cleanest* geometry in the box: the
only candidate that merges into a single unbroken 2.3 km chain.

## Three forced scope changes

**Change 1 · Corridors get declared roles instead of uniform requirements.** The old rule — "at least
one bus route touching each corridor" — is unsatisfiable and was wrong. Final set:

| Corridor | Role | Evidence |
|---|---|---|
| **Baba Kharak Singh Marg** | Bus-frequency hero — highest service intensity in the box | 75 route refs |
| **Barakhamba Road** | Commercial congestion corridor; cleanest bus-corridor geometry | 15 refs, 2 chains |
| **Kartavya Path** | Orientation spine + traffic/rainfall corridor. **No transit layer** | 1 chain, 2,346 m, 0 refs |

Janpath becomes the documented alternate and the V1.5 connector (14 stops, but 10 fragmented chains).
**New UI requirement:** the bus-frequency scenario is corridor-scoped and must visibly disable itself
on Kartavya Path with a stated reason, rather than silently returning zero.

**Change 2 · Tiling is over-engineering — drop it.** The whole box holds ~96,000 triangles of
ordinary buildings. That was sized against an assumed ~3,000 buildings/km²; the real figure is 206.
A 4 × 4 tile grid would be machinery serving nothing. Ordinary buildings ship as **one GLB** (measured
in §4), with the tile grid retained only as a spatial index for entity lookup.

**Change 3 · The ground plane carries this city, not the buildings.** 13.7% footprint coverage against
58.5% landuse coverage is the real character of Lutyens' Delhi — sparse, green, low-rise, big
government estates. A building-only render will read as empty and unconvincing. Parks, gardens, grass
and the road surface itself must be first-class rendered layers, not background. This raises the
priority of the landuse layer from "not mentioned in the PRD" to **P0 for the "convincing city"
acceptance criterion.**

Also: only **8.2%** of buildings have a real height. The estimated-height rule is therefore load-bearing
for ~92% of the city and must be disclosed prominently, not in a footnote.

## Verified landmark footprints

Resolved by name query — my proposed "Sansad Bhavan" does not exist in OSM under that name.

| Landmark | OSM id | OSM height | Role |
|---|---|---|---|
| India Gate | `way/361709652` | — | **Required.** Anchors Kartavya Path |
| Old Parliament House | `relation/6087635` | 21 m | **Required.** Circular colonnade, distinctive silhouette, cheap to model |
| Connaught Place / Rajiv Chowk Central Park | `way/164675825` | — | **Required.** Anchors both bus corridors |
| Rashtrapati Bhavan | `relation/5354966` | 20 m | Optional |
| North Block / South Block | `relation/5507630` / `5507631` | 30 m each | Optional — they frame the ceremonial axis |
| New Parliament House | `relation/12737019` | 39.6 m | Optional |
| Jantar Mantar | `way/223456559` | — | Optional |

## 4. Bake-off and 5. alignment proof
See `docs/06-SPIKE-0-BAKEOFF.md`.
