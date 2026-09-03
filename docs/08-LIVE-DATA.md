# 08 — Live data, and the one problem this solves

Up to here everything was observed *geometry* with estimated or simulated dynamics. This is the
first live, observed **measurement** in the product — and it exists because it answers a question a
Delhi resident actually has.

## The user problem

Congestion is the obvious thing to model and the less useful one. The daily, high-stakes question
in Delhi is not *"is this road slow"* — it is:

> **"How much bad air will I breathe getting there, and can I do anything about it?"**

Measured on 3 September 2026 at the study-area centre: **PM2.5 71.2 µg/m³ — 4.7× the WHO 24-hour
guideline of 15.** That is not a modelling assumption. It is what the air was.

So the Exposure panel (`Air & exposure`, or `A`) answers three things:

1. **What is in the air right now**, anchored against the WHO guideline, because "71" means nothing
   on its own.
2. **How much of it you inhale** on a journey along a corridor, by mode — walk, cycle, bus, car.
3. **Whether a different hour is better**, from the hourly forecast.

### The non-obvious result

On a bus journey the **waiting usually dominates the dose, not the riding**. Measured in the app on
Baba Kharak Singh Marg: *waiting is 51% of the total*. You stand at the kerb, breathing harder than
you would sitting, in air enriched by the traffic you are waiting to join.

Which means **bus frequency is an air-quality intervention, not only a wait-time one** — and the
existing bus-frequency scenario now shows that second effect. That is the kind of finding the whole
project was built to surface: two independent layers meeting to say something neither could alone.

## What is measured and what is assumed

The split matters more here than anywhere else in the product, because a dose figure sounds
clinical.

| | |
|---|---|
| **Observed** | PM2.5, PM10, NO₂, SO₂, O₃, CO concentrations, and the hourly forecast. Open-Meteo / Copernicus CAMS. |
| **Declared heuristic** | Everything that turns a concentration into a dose: minute ventilation by activity, indoor penetration, kerbside enrichment. Versioned in `scenario-model-0.1.json:exposure_model`, printed in the panel. |
| **Inherited estimate** | Wait and travel times come from the corridor model, which is itself a declared time-of-day heuristic, not observed speeds. |

    dose (µg) = concentration × ventilation (m³/min) × minutes × penetration × kerbside enrichment

And the limits are stated in the panel, not buried: it is a modelled reanalysis product rather than
a kerbside monitor, it cannot resolve a single congested junction, and a dose figure is a rough
comparative indicator — **not medical advice**.

### One value for the whole box, and why there is no air-quality map

Measured before building anything: querying all four corners of the 4 km study area returns the
**identical** figure, and the API snaps them to a single coordinate. The CAMS grid is about 11 km.

So there is **no spatial air-quality layer anywhere in this product.** A heat-map over the box would
have looked far more impressive and would have been entirely invented. Real intra-city variation in
Delhi is large; this dataset simply cannot resolve it, and the panel says so.

## Live adapters, and the gate on them

`manifest.health.live_adapters` lists what a build may contact. **The app contacts nothing that is
not on that list.**

| Adapter | Key | Default | Status |
|---|---|---|---|
| `open_meteo_air_quality` | none | **on** | live |
| `open_meteo_weather` | none | **on** | live — the observed rain rate drives the rainfall control |
| `otd_vehicle_positions` | **required** | off | built, waiting on a key |

That list is not decoration. A build without a key must not fire a request that can only fail: it
logs a console error for every user and claims a capability the deployment does not have. My own
browser QA caught exactly that — a 404 on `/api/vehicles` — which is why the gate exists.

The scope lock is intact: with every adapter off the app runs on the pinned snapshot, says
`offline build`, and the guided demo completes.

## Live buses — built, needs one credential

This is the real thing: actual DTC vehicle positions, not replay. It is written and ready.

Two reasons it cannot work from the browser alone, both predicted in `02-ARCHITECTURE.md` before
either adapter existed:

1. **The key must stay server-side** (NFR). So the browser calls our own `/api/vehicles`.
2. **`otd.delhi.gov.in` sends no CORS headers**, so a direct browser fetch is impossible regardless.
   The proxy is not optional.

### What is already written

- `web/src/data/adapters/gtfsRealtime.ts` — the adapter, including a **hand-written GTFS-Realtime
  protobuf reader**. Six fields do not justify pulling in `gtfs-realtime-bindings` plus
  `protobufjs` in a project whose argument is that it runs from bundled data.
- `web/api/vehicles.ts` — Vercel edge function. Returns **501 when unconfigured**, which the client
  treats as a normal resting state.
- `web/src/layers/liveBuses.ts` — renders real vehicles in a distinct brighter body, and
  **switches the replay layer off when live positions arrive**, because showing both would put
  invented buses next to real ones on the same street.

### To turn it on

1. Register at **https://otd.delhi.gov.in/** and request an API key for GTFS-Realtime
   `VehiclePositions`. Realtime access is granted to authorised users, which is why this is the one
   piece that cannot be self-served.
2. Set `OTD_API_KEY` on the deployment (or in a local `.env` for `vercel dev`).
3. Flip `live_adapters.otd_vehicle_positions` to `true` in `config/study-area.json` and re-run
   `make data`.
4. `make qa` — the harness asserts the feed reports a real state and that replay yields to it.

Until step 1 exists, the layer reports `unconfigured` in the layer rail and states in its own
provenance that nothing on screen is claiming to be a live position.

## What is deliberately still absent

- **Live traffic speeds.** TomTom needs a key and its caching terms need reading before anything is
  stored. The corridor estimate stays labelled estimated. `04-DATA-REGISTER.md` D10.
- **Kerbside air monitors.** CPCB runs real monitors in Delhi whose readings would beat a reanalysis
  grid. Access terms need checking; until then the honest thing is the coarse feed plus a clear
  statement of what it cannot resolve.
- **An air-quality surface.** Not a scope decision — the data does not support it. See above.

---

# OTD key received — what the feed actually gives, verified

Key configured 2026-09-04. Everything below is measured against the live endpoint, not read off the
GTFS-Realtime spec.

## Verified now

| | |
|---|---|
| `GET /api/realtime/VehiclePositions.pb?key=…` | **HTTP 200** |
| payload | 15 bytes — a valid `FeedHeader` |
| `gtfs_realtime_version` | `2.0` |
| `incrementality` | `0` (FULL_DATASET) |
| feed timestamp | **2 seconds old** on repeat polls |
| vehicle entities | **0**, at 23:55 and 00:01 IST |

Zero vehicles is a real answer, not a failure: DTC and DIMTS buses are off the road at midnight and
the operator publishes an empty feed. `pipeline/record_vehicles.py` is recording every 30 s through
to late morning so the service-hours picture is measured rather than guessed.

**The static files are a separate problem.** They are not served from a URL. The files live on
`traffickarma.iiitd.edu.in:9010`, which is unreachable from outside their network (probed: refused
on port 80 and 9010). The only route is a POST to `https://otd.delhi.gov.in/data/static/` behind a
form requiring a name, an email, a commercial/non-commercial declaration and a terms checkbox.
`pipeline/fetch_gtfs.py` implements it and takes those as required arguments — it refuses to run on
placeholders, because submitting `test@example.com` to a government portal is worse than not
downloading the data. Four datasets are offered: `stops`, `routes`, `trips`, `stop_times`. Note
what is **not**: no `shapes.txt`, so GTFS gives no route geometry, and no `calendar.txt`.

## Two changes the real feed forced

**Live ≠ has buses in it.** `reconcileBuses` superseded the replay layer on `state === "live"`
alone. Against the real empty feed that removed every bus from the scene and replaced them with
nothing. Replay is now superseded only when there is something to supersede it with, and the feed
chip distinguishes *no buses anywhere in the feed* from *none inside this 16 km² box*.

**The decoder read six fields, which is enough for a dot on a map.** Position is the least
interesting thing in this feed. It now reads twelve, and `pipeline/record_vehicles.py` counts which
of them Delhi actually populates, because GTFS-Realtime makes nearly everything optional and "the
spec supports occupancy" is worth nothing to a user. `license_plate` is deliberately not read.

## Why this matters more than smoother markers

Three lines currently in the UI, all of them honest and all of them admissions:

- *"Corridor colour is estimated from a declared time-of-day heuristic, not observed speeds."*
- *"From an assumed 6.0 min combined headway across routes 73, 604."*
- *"Wait-time proxy — half the headway. A proxy, not a measurement."*

The exposure product rests on that third line: waiting is 51% of the bus dose, computed from an
assumed wait. Each of these becomes *observed* with fields this feed carries — `speed` for the
first, `current_status` + `stop_id` + `timestamp` for the second and third. That is the value here:
not a nicer bus marker, but converting the app's central numbers from estimated to observed.

A recorded day also unlocks something the scope lock otherwise forbids. Live data can never be
*required* — the demo must work with every provider disabled. But a recording is **bundled**, and
`replay` is already a declared mode in the provenance vocabulary that this project has never been
able to use honestly. Recording turns the bus layer from `simulated` to `replay` with a real
`source_time`, with no live dependency at all.
