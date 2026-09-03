#!/usr/bin/env python3
"""Invariants for the observed-transit analyser.

Written BEFORE any real bus data existed, against a fixture in the exact format
`pipeline/record_vehicles.py` writes. That ordering is deliberate: the two ways this analyser can
fail both produce plausible-looking numbers rather than errors, so they have to be pinned by a test
with known-correct answers rather than eyeballed once real data arrives.

The failure modes:
  1. A bus parked at a terminus emits STOPPED_AT on every poll. Counting each as an arrival reports
     a 30-second headway on a route that runs every 20 minutes.
  2. The same bus completing a loop legitimately arrives at the same stop twice. A dedupe on
     (vehicle, stop) would throw the second one away.
"""
from __future__ import annotations
import json, pathlib, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
from dpt import observed                                                    # noqa: E402

failures: list[str] = []
checks = 0


def check(cond: bool, msg: str):
    global checks
    checks += 1
    if not cond:
        failures.append(msg)


def rec(t, vid, *, status=None, stop=None, route="R1", lat=28.63, lon=77.22, speed=None, occ=None):
    return {"vehicle_id": vid, "current_status": status, "stop_id": stop, "route_id": route,
            "timestamp": t, "lat": lat, "lon": lon, "speed_ms": speed, "occupancy_status": occ,
            "_poll_at": f"poll{t}", "_feed_time": t, "_in_box": True}


# ---------------------------------------------------------------- arrivals are edge-triggered
# A parked at S1 for four polls, then leaves, then comes back. Two arrivals, not five.
parked = [
    rec(100, "A", status="STOPPED_AT", stop="S1"),
    rec(130, "A", status="STOPPED_AT", stop="S1"),
    rec(160, "A", status="STOPPED_AT", stop="S1"),
    rec(190, "A", status="STOPPED_AT", stop="S1"),
    rec(220, "A", status="IN_TRANSIT_TO", stop="S2"),
    rec(250, "A", status="STOPPED_AT", stop="S2"),
    rec(900, "A", status="STOPPED_AT", stop="S1"),          # a legitimate second visit
]
ev = observed.arrivals(parked)
check(len(ev) == 3,
      f"edge-triggering wrong: expected 3 arrivals (S1, S2, S1 again), got {len(ev)}")
check([e["stop_id"] for e in ev] == ["S1", "S2", "S1"],
      f"arrival order/stops wrong: {[e['stop_id'] for e in ev]}")
check([e["t"] for e in ev] == [100, 250, 900],
      f"arrival timestamps should be the first poll of each dwell: {[e['t'] for e in ev]}")

# ---------------------------------------------------------------- headway needs different vehicles
# At S1: A at t=0, B at t=600, C at t=1200 -> two 600 s gaps. A returning must not create a gap.
seq = [
    rec(0, "A", status="STOPPED_AT", stop="S1"),
    rec(30, "A", status="IN_TRANSIT_TO", stop="S2"),
    rec(600, "B", status="STOPPED_AT", stop="S1"),
    rec(630, "B", status="IN_TRANSIT_TO", stop="S2"),
    rec(1200, "C", status="STOPPED_AT", stop="S1"),
]
h = observed.headways(observed.arrivals(seq))
pair = h["per_route_stop"].get("R1|S1")
check(pair is not None, "no headway computed for R1|S1")
if pair:
    check(pair["n"] == 2, f"expected 2 headway gaps at R1|S1, got {pair['n']}")
    check(pair["median_s"] == 600, f"expected a 600 s median headway, got {pair['median_s']}")

same_vehicle = [
    rec(0, "A", status="STOPPED_AT", stop="S1"),
    rec(30, "A", status="IN_TRANSIT_TO", stop="S2"),
    rec(600, "A", status="STOPPED_AT", stop="S1"),
]
h2 = observed.headways(observed.arrivals(same_vehicle))
check("R1|S1" not in h2["per_route_stop"],
      "one vehicle looping produced a headway; a following service requires a different vehicle")

# ---------------------------------------------------------------- irregular service costs riders
# Gaps of 90 s and 1110 s: mean 600 s, so the old proxy says 5 min. The real expected wait for a
# passenger arriving at random is E[h^2]/(2E[h]) = (90^2 + 1110^2) / (2*1200) = 516.75 s = 8.61 min.
# The gap sizes sit clear of BUNCH_HEADWAY_S rather than exactly on it: an assertion pinned to a
# threshold tests the boundary by accident and breaks when the constant is tuned.
irregular = [
    rec(0, "A", status="STOPPED_AT", stop="S9"),
    rec(30, "A", status="IN_TRANSIT_TO", stop="S8"),
    rec(90, "B", status="STOPPED_AT", stop="S9"),
    rec(120, "B", status="IN_TRANSIT_TO", stop="S8"),
    rec(1200, "C", status="STOPPED_AT", stop="S9"),
]
hi = observed.headways(observed.arrivals(irregular))
r = hi["per_route"].get("R1")
check(r is not None, "no per-route headway summary")
if r:
    check(r["half_headway_min"] == 5.0,
          f"half-headway proxy should be 5.0 min for a 600 s mean, got {r['half_headway_min']}")
    check(abs(r["mean_wait_min"] - 8.61) < 0.05,
          f"expected wait should be 8.61 min under this irregular service, got {r['mean_wait_min']}")
    check(r["mean_wait_min"] > r["half_headway_min"],
          "the expected wait must exceed half the mean headway when service is irregular — that "
          "gap is precisely what bunching costs a passenger, and it is why the old proxy flattered "
          "the service")
check(hi["bunched_pairs"] == 1, f"expected 1 bunched pair (the 90 s gap), got {hi['bunched_pairs']}")

# ---------------------------------------------------------------- speeds exclude dwell
sp = observed.speeds([
    rec(0, "A", status="IN_TRANSIT_TO", speed=8.0),
    rec(30, "A", status="IN_TRANSIT_TO", speed=6.0),
    rec(60, "A", status="STOPPED_AT", stop="S1", speed=0.0),     # dwell: excluded
    rec(90, "A", status="IN_TRANSIT_TO", speed=0.3),             # crawling: excluded
    rec(120, "A", status="IN_TRANSIT_TO", speed=None),           # field absent: counted separately
])
check(sp["samples"] == 2, f"expected 2 usable speed samples, got {sp['samples']}")
check(sp["skipped_dwell"] == 2, f"expected 2 dwell/crawl exclusions, got {sp['skipped_dwell']}")
check(sp["skipped_missing"] == 1, f"expected 1 missing-speed record, got {sp['skipped_missing']}")
check(sp["median_kmh"] == 25.2, f"median of 8 and 6 m/s should be 25.2 km/h, got {sp['median_kmh']}")

# a feed that never populates speed must say so rather than report a number
none_sp = observed.speeds([rec(0, "A", status="IN_TRANSIT_TO")])
check(none_sp["samples"] == 0 and "note" in none_sp,
      "a feed with no speed field must report zero samples and say why")

# ---------------------------------------------------------------- bunching by distance
close = observed.bunching([
    rec(0, "A", lat=28.6300, lon=77.2200),
    rec(0, "B", lat=28.6301, lon=77.2201),          # ~14 m apart: bunched
    rec(0, "C", lat=28.6400, lon=77.2300),          # ~1.4 km away: not
])
check(close["co_located_pairs"] == 1,
      f"expected exactly 1 co-located pair, got {close['co_located_pairs']}")
check(close["route_pairs_examined"] == 3,
      f"expected 3 pairs examined among 3 vehicles, got {close['route_pairs_examined']}")

# ---------------------------------------------------------------- end to end over a real-format file
with tempfile.TemporaryDirectory() as d:
    p = pathlib.Path(d) / "vehicles.ndjson"
    p.write_text("\n".join(json.dumps(r) for r in seq + parked) + "\n")
    out = observed.analyse(p)
    check(out["_mode"] == "observed", "analyse() must declare mode observed")
    check(out["observations"] == len(seq) + len(parked),
          f"observation count wrong: {out['observations']}")
    check(out["arrival_events"] > 0, "no arrival events from the end-to-end fixture")
    check("_bias_note" in out["speeds"] or out["speeds"]["samples"] == 0,
          "speed output must declare the bus-probe bias whenever it reports numbers")

# ---------------------------------------------------------------- report
print()
if failures:
    for f in failures:
        print(f"  FAIL  {f}")
    print(f"\n  {len(failures)} of {checks} observed-transit invariants FAILED\n")
    sys.exit(1)
print(f"  all {checks} observed-transit invariants hold "
      f"(fixture-based; awaiting real service-hours data)\n")
