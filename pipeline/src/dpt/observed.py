"""Turn recorded vehicle positions into OBSERVED transit measurements.

This is the point of having the feed at all. The app's three load-bearing numbers are currently
admissions printed in its own UI:

    "Corridor colour is estimated from a declared time-of-day heuristic, not observed speeds."
    "From an assumed 6.0 min combined headway across routes 73, 604."
    "Wait-time proxy - half the headway. A proxy, not a measurement."

The exposure product rests on the third: waiting is 51% of the bus dose, computed from an assumed
wait. Everything here exists to replace those three with measurements.

**Arrival events.** GTFS-Realtime gives `current_status`, `stop_id` and `timestamp` per vehicle. A
vehicle transitioning into `STOPPED_AT` a stop is an arrival. Consecutive arrivals of different
vehicles at the same stop on the same route are an observed headway. That is a measurement, not a
proxy, and it is the number the wait-time and exposure figures should be built on.

Two failure modes this guards against, because both would silently produce plausible nonsense:

  - A vehicle sitting at a terminus emits `STOPPED_AT` for many consecutive polls. Counting each as
    an arrival would report a headway of 30 seconds. So arrivals are edge-triggered: a vehicle must
    have been seen NOT stopped at that stop before a new arrival is recorded.
  - The same vehicle looping a route arrives at the same stop twice legitimately, hours apart.
    Edge-triggering handles that correctly; a simple dedupe on (vehicle, stop) would not.

**Speeds.** `speed` is the operator's own GPS speed. Buses are a biased probe for traffic: they
stop at stops, and may use bus lanes. So dwell samples are excluded (`STOPPED_AT`, and anything
below a walking pace), and the bias is declared in the output rather than corrected for.

Nothing here is derived from a field the feed does not populate. `coverage` in the recorder's report
says which those are, and every metric below reports the sample count it rests on.
"""
from __future__ import annotations
import collections, datetime, json, math, pathlib, statistics

# a vehicle reporting slower than this is treated as dwelling or crawling, not as traffic speed
MIN_TRAFFIC_MS = 1.5
# Two vehicles on one route arriving within this many seconds of each other are bunched.
# Inclusive: "within two minutes" reads as including two minutes.
BUNCH_HEADWAY_S = 120
# ignore absurd headways: a gap longer than this is a service break, not a frequency
MAX_HEADWAY_S = 3 * 3600


def _iter(path: pathlib.Path):
    with path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def arrivals(records) -> list[dict]:
    """Edge-triggered arrival events: (vehicle, stop) transitions into STOPPED_AT."""
    last_stop_state: dict[str, tuple[str | None, str | None]] = {}
    out: list[dict] = []
    for r in records:
        vid = r.get("vehicle_id") or r.get("entity_id")
        if not vid:
            continue
        stop = r.get("stop_id")
        status = r.get("current_status")
        prev = last_stop_state.get(vid)
        # the edge: previously not stopped at THIS stop, now stopped at it
        if status == "STOPPED_AT" and stop and prev != ("STOPPED_AT", stop):
            # `or` and truthiness are both wrong here: a Unix timestamp of 0 is falsy, so the
            # fallback fires on a valid value and the guard then drops the record entirely. Real
            # feed timestamps are ~1.7e9 so this would never have bitten in production, which is
            # exactly why it needed a fixture to catch it.
            ts = r.get("timestamp")
            if ts is None:
                ts = r.get("_feed_time")
            if ts is not None:
                out.append({"vehicle_id": vid, "stop_id": stop,
                            "route_id": r.get("route_id"), "t": int(ts),
                            "trip_id": r.get("trip_id"),
                            "occupancy": r.get("occupancy_status")})
        last_stop_state[vid] = (status, stop)
    out.sort(key=lambda a: a["t"])
    return out


def headways(events: list[dict]) -> dict:
    """Observed headway per (route, stop), and per route overall."""
    by_key: dict[tuple, list[dict]] = collections.defaultdict(list)
    for e in events:
        if e["route_id"] and e["stop_id"]:
            by_key[(e["route_id"], e["stop_id"])].append(e)

    per_pair, per_route = {}, collections.defaultdict(list)
    bunched = 0
    for (route, stop), evs in by_key.items():
        evs.sort(key=lambda x: x["t"])
        gaps = []
        for a, b in zip(evs, evs[1:]):
            if b["vehicle_id"] == a["vehicle_id"]:
                continue                      # same bus round again, not a following service
            gap = b["t"] - a["t"]
            if 0 < gap <= MAX_HEADWAY_S:
                gaps.append(gap)
                if gap <= BUNCH_HEADWAY_S:
                    bunched += 1
        if gaps:
            per_pair[f"{route}|{stop}"] = {
                "n": len(gaps),
                "median_s": int(statistics.median(gaps)),
                "mean_s": int(statistics.fmean(gaps)),
                "min_s": min(gaps), "max_s": max(gaps),
            }
            per_route[route].extend(gaps)

    routes = {}
    for route, gaps in per_route.items():
        gaps.sort()
        routes[route] = {
            "n": len(gaps),
            "median_s": int(statistics.median(gaps)),
            "median_min": round(statistics.median(gaps) / 60, 1),
            "p90_s": gaps[min(len(gaps) - 1, int(0.9 * len(gaps)))],
            # what a rider actually waits is not half the mean headway when service is irregular:
            # E[wait] = E[h^2] / (2 E[h]), which the mean under-states exactly when bunching happens
            "mean_wait_min": round(
                sum(g * g for g in gaps) / (2 * sum(gaps)) / 60, 2) if sum(gaps) else None,
            "half_headway_min": round(statistics.fmean(gaps) / 2 / 60, 2),
        }
    return {"per_route_stop": per_pair, "per_route": routes,
            "bunched_pairs": bunched,
            "_wait_note": "mean_wait_min is E[h^2]/(2E[h]), the expected wait of a rider arriving "
                          "at random. half_headway_min is the proxy the app used before this "
                          "existed. They diverge exactly when service is irregular, and the "
                          "difference is what bunching costs a passenger."}


def derived_speeds(records, min_dt=10, max_dt=180, max_kmh=90.0) -> dict:
    """Speed from successive positions of the same vehicle, because the feed's own speed is dead.

    MEASURED: `Position.speed` is populated on 100% of Delhi's vehicle records and is **always
    exactly 0.0**. The field exists, so an integration that trusts the spec would have "speed data"
    and would report 0 km/h across the whole city. It carries no information at all.

    What the feed does carry, at 100%, is position, timestamp and a stable vehicle id, polled every
    30 s. Differencing consecutive fixes for one vehicle recovers a real speed. That is DERIVED
    rather than observed and is labelled so, but it rests on observed positions instead of on a
    diurnal curve somebody authored.

    Guards, each for a specific way this goes wrong:
      - same vehicle AND same trip, or a vehicle starting its next run teleports across the city
      - dt within [min_dt, max_dt]: a 10 s gap makes GPS jitter look like speed, and an hour-long
        gap averages away everything that happened in between
      - great-circle distance, not planar, because Delhi spans enough longitude to matter
      - anything above max_kmh is a bad fix rather than a fast bus, and is dropped and counted
    """
    by_veh = collections.defaultdict(list)
    for r in records:
        vid = r.get("vehicle_id") or r.get("entity_id")
        ts = r.get("timestamp") if r.get("timestamp") is not None else r.get("_feed_time")
        if vid and ts is not None and r.get("lat") is not None:
            by_veh[vid].append((int(ts), r["lat"], r["lon"], r.get("trip_id"), r.get("route_id")))

    kmh, by_hour, by_route = [], collections.defaultdict(list), collections.defaultdict(list)
    pairs = dropped_dt = dropped_fast = dropped_trip = 0
    for vid, fixes in by_veh.items():
        fixes.sort()
        for (t0, la0, lo0, tr0, _r0), (t1, la1, lo1, tr1, r1) in zip(fixes, fixes[1:]):
            if tr0 != tr1:
                dropped_trip += 1
                continue
            dt = t1 - t0
            if dt < min_dt or dt > max_dt:
                dropped_dt += 1
                continue
            dlat = math.radians(la1 - la0)
            dlon = math.radians(lo1 - lo0)
            a = (math.sin(dlat / 2) ** 2
                 + math.cos(math.radians(la0)) * math.cos(math.radians(la1))
                 * math.sin(dlon / 2) ** 2)
            metres = 2 * 6371000 * math.asin(min(1.0, math.sqrt(a)))
            v = (metres / dt) * 3.6
            pairs += 1
            if v > max_kmh:
                dropped_fast += 1
                continue
            kmh.append(v)
            by_route[r1].append(v)
            by_hour[datetime.datetime.fromtimestamp(
                t1, datetime.timezone(datetime.timedelta(hours=5, minutes=30))).hour].append(v)

    if not kmh:
        return {"samples": 0, "note": "no usable consecutive position pairs"}
    kmh.sort()
    q = lambda p: kmh[min(len(kmh) - 1, int(p * len(kmh)))]
    moving = [v for v in kmh if v >= 2.0]
    return {
        "samples": len(kmh), "pairs_considered": pairs,
        "dropped_trip_change": dropped_trip, "dropped_bad_dt": dropped_dt,
        "dropped_implausible": dropped_fast,
        "median_kmh": round(statistics.median(kmh), 1),
        "p10_kmh": round(q(0.10), 1), "p90_kmh": round(q(0.90), 1),
        "stopped_share": round(sum(1 for v in kmh if v < 2.0) / len(kmh), 3),
        "median_when_moving_kmh": round(statistics.median(moving), 1) if moving else None,
        "by_hour_kmh": {str(h): round(statistics.median(v), 1)
                        for h, v in sorted(by_hour.items()) if len(v) >= 20},
        "_mode": "derived from observed positions",
        "_bias_note": "A bus is a BIASED probe for traffic speed: it stops at stops, pulls in and "
                      "out of the kerb, and may use a bus lane. `median_when_moving_kmh` excludes "
                      "fixes below 2 km/h, which removes dwell but not the rest of the bias. Treat "
                      "it as a lower bound on general traffic speed, not a measurement of it.",
    }


def speeds(records) -> dict:
    """The feed's OWN speed field. Kept to demonstrate that it is dead — see derived_speeds."""
    vals, by_hour = [], collections.defaultdict(list)
    used = skipped_dwell = skipped_missing = 0
    for r in records:
        v = r.get("speed_ms")
        if v is None:
            skipped_missing += 1
            continue
        if r.get("current_status") == "STOPPED_AT" or v < MIN_TRAFFIC_MS:
            skipped_dwell += 1
            continue
        used += 1
        vals.append(v)
        ts = r.get("timestamp")
        if ts is None:
            ts = r.get("_feed_time")
        if ts is not None:
            by_hour[datetime.datetime.fromtimestamp(
                int(ts), datetime.timezone(datetime.timedelta(hours=5, minutes=30))).hour].append(v)
    if not vals:
        return {"samples": 0, "skipped_dwell": skipped_dwell, "skipped_missing": skipped_missing,
                "note": "no usable speed samples — the feed may not populate Position.speed"}
    vals.sort()
    q = lambda p: vals[min(len(vals) - 1, int(p * len(vals)))]
    return {
        "samples": used, "skipped_dwell": skipped_dwell, "skipped_missing": skipped_missing,
        "median_kmh": round(statistics.median(vals) * 3.6, 1),
        "p10_kmh": round(q(0.10) * 3.6, 1), "p90_kmh": round(q(0.90) * 3.6, 1),
        "by_hour_kmh": {str(h): round(statistics.median(v) * 3.6, 1)
                        for h, v in sorted(by_hour.items()) if len(v) >= 5},
        "_bias_note": "Bus GPS is a BIASED probe for traffic speed: buses stop at stops, pull in "
                      "and out of the kerb, and may use bus lanes. Dwell samples and anything "
                      "below 1.5 m/s are excluded, but the remaining bias is not corrected for — "
                      "it is declared. This is a lower bound on general traffic speed.",
    }


def bunching(records) -> dict:
    """Vehicles on the same route within 250 m of each other at the same poll."""
    by_poll: dict[tuple, list[dict]] = collections.defaultdict(list)
    for r in records:
        if r.get("route_id") and r.get("lat") is not None:
            by_poll[(r.get("_poll_at"), r["route_id"])].append(r)
    pairs = total = 0
    for (_poll, _route), vs in by_poll.items():
        if len(vs) < 2:
            continue
        for i in range(len(vs)):
            for j in range(i + 1, len(vs)):
                a, b = vs[i], vs[j]
                if a.get("vehicle_id") == b.get("vehicle_id"):
                    continue
                total += 1
                # 1 degree of latitude ~ 111.3 km; longitude scaled by cos(lat) at Delhi
                dy = (a["lat"] - b["lat"]) * 111_300
                dx = (a["lon"] - b["lon"]) * 111_300 * math.cos(math.radians(28.62))
                if math.hypot(dx, dy) < 250:
                    pairs += 1
    return {"co_located_pairs": pairs, "route_pairs_examined": total,
            "share": round(pairs / total, 4) if total else None,
            "_note": "Two vehicles on one route within 250 m at the same poll. The motion model "
                     "in the app already produces bunching as an emergent property of releasing "
                     "buses at fixed time headway and inverting travel time; this is the first "
                     "measurement it can be checked against."}


def analyse(ndjson: pathlib.Path, box_only: bool = False) -> dict:
    recs = [r for r in _iter(ndjson) if (not box_only or r.get("_in_box"))]
    ev = arrivals(recs)
    vehicles = {r.get("vehicle_id") for r in recs if r.get("vehicle_id")}
    routes = {r.get("route_id") for r in recs if r.get("route_id")}
    return {
        "source": str(ndjson),
        "generated_at": datetime.datetime.now().astimezone().isoformat(),
        "scope": "study box only" if box_only else "all of Delhi in the feed",
        "observations": len(recs),
        "distinct_vehicles": len(vehicles),
        "distinct_routes": len(routes),
        "arrival_events": len(ev),
        "headways": headways(ev),
        "feed_speed_field": speeds(recs),
        "speeds": derived_speeds(recs),
        "bunching": bunching(recs),
        "_mode": "observed",
        "_provenance": "Delhi Open Transit Data GTFS-Realtime VehiclePositions, recorded by "
                       "pipeline/record_vehicles.py. Positions and speeds are the operator's own "
                       "reported GPS; accuracy, update interval and coverage are theirs.",
    }
