#!/usr/bin/env python3
"""Record the Delhi OTD GTFS-Realtime vehicle feed, and audit what it actually contains.

Two jobs, and the second is the reason this exists.

**Record.** Poll the feed, append every vehicle observation to NDJSON. A day of this is a genuine
observed dataset, which matters because the app's bus layer is currently `mode: simulated` — the
vehicles are invented from a declared headway. Real recorded positions turn that layer into
`mode: replay` with real provenance, which is a declared mode the project already has and has never
been able to use.

**Audit.** The GTFS-Realtime spec has a lot of optional fields, and a feed is free to populate none
of them. Listing what the spec allows would be worthless; what matters is what Delhi actually
sends. So every field is counted, and the report says what share of observations carried it. That
is the difference between "GTFS-RT can report occupancy" and "this feed reports occupancy for 84%
of vehicles".

Deliberately NOT recorded: `license_plate`. It is in the spec, buses are public vehicles, and it is
still a registration number tied to a physical asset — it buys this project nothing and it would
end up in a committed data file. `vehicle.id` and `label` are kept because routing and bunching
analysis need a stable per-vehicle identity.

Usage:
  python pipeline/record_vehicles.py --minutes 720 --interval 20
  python pipeline/record_vehicles.py --once            # one poll, print the audit, exit

Reads OTD_API_KEY from the environment (or --key). Writes spike/_raw/otd/vehicles-<date>.ndjson
and spike/_raw/otd/coverage-<date>.json.
"""
from __future__ import annotations
import argparse, collections, datetime, json, os, pathlib, struct, sys, time
import urllib.error, urllib.request

URL = "https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb"
OUT = pathlib.Path("spike/_raw/otd")
BOX = {"w": 77.1975, "s": 28.6039, "e": 77.2385, "n": 28.6401}

CURRENT_STATUS = {0: "INCOMING_AT", 1: "STOPPED_AT", 2: "IN_TRANSIT_TO"}
CONGESTION = {0: "UNKNOWN_CONGESTION_LEVEL", 1: "RUNNING_SMOOTHLY", 2: "STOP_AND_GO",
              3: "CONGESTION", 4: "SEVERE_CONGESTION"}
OCCUPANCY = {0: "EMPTY", 1: "MANY_SEATS_AVAILABLE", 2: "FEW_SEATS_AVAILABLE",
             3: "STANDING_ROOM_ONLY", 4: "CRUSHED_STANDING_ROOM_ONLY", 5: "FULL",
             6: "NOT_ACCEPTING_PASSENGERS", 7: "NO_DATA_AVAILABLE", 8: "NOT_BOARDABLE"}
SCHEDULE_REL = {0: "SCHEDULED", 1: "ADDED", 2: "UNSCHEDULED", 3: "CANCELED", 5: "REPLACEMENT"}


# ---------------------------------------------------------------- protobuf
def read_varint(b: bytes, i: int) -> tuple[int, int]:
    r = 0; s = 0
    while True:
        if i >= len(b):
            raise ValueError("truncated varint")
        x = b[i]; i += 1
        r |= (x & 0x7F) << s; s += 7
        if not x & 0x80:
            return r, i


def fields(b: bytes):
    """Yield (field_number, wire_type, payload) for one message body."""
    i = 0
    while i < len(b):
        tag, i = read_varint(b, i)
        f, wt = tag >> 3, tag & 7
        if wt == 0:
            v, i = read_varint(b, i); yield f, wt, v
        elif wt == 1:
            yield f, wt, b[i:i + 8]; i += 8
        elif wt == 2:
            n, i = read_varint(b, i); yield f, wt, b[i:i + n]; i += n
        elif wt == 5:
            yield f, wt, b[i:i + 4]; i += 4
        else:
            raise ValueError(f"unsupported wire type {wt}")


f32 = lambda p: struct.unpack("<f", p)[0]
f64 = lambda p: struct.unpack("<d", p)[0]
s = lambda p: p.decode("utf-8", "replace")


def parse_trip(b: bytes) -> dict:
    o = {}
    for f, wt, p in fields(b):
        if f == 1 and wt == 2: o["trip_id"] = s(p)
        elif f == 5 and wt == 2: o["route_id"] = s(p)
        elif f == 6 and wt == 0: o["direction_id"] = p
        elif f == 2 and wt == 2: o["start_time"] = s(p)
        elif f == 3 and wt == 2: o["start_date"] = s(p)
        elif f == 4 and wt == 0: o["schedule_relationship"] = SCHEDULE_REL.get(p, p)
    return o


def parse_position(b: bytes) -> dict:
    o = {}
    for f, wt, p in fields(b):
        if f == 1 and wt == 5: o["lat"] = round(f32(p), 6)
        elif f == 2 and wt == 5: o["lon"] = round(f32(p), 6)
        elif f == 3 and wt == 5: o["bearing"] = round(f32(p), 1)
        elif f == 4 and wt == 1: o["odometer"] = f64(p)
        elif f == 5 and wt == 5: o["speed_ms"] = round(f32(p), 3)
    return o


def parse_vehicle_desc(b: bytes) -> dict:
    o = {}
    for f, wt, p in fields(b):
        if f == 1 and wt == 2: o["vehicle_id"] = s(p)
        elif f == 2 and wt == 2: o["vehicle_label"] = s(p)
        # field 3 is license_plate: deliberately not read. See the module docstring.
    return o


def parse_vehicle_position(b: bytes) -> dict:
    o = {}
    for f, wt, p in fields(b):
        if f == 1 and wt == 2: o.update(parse_trip(p))
        elif f == 2 and wt == 2: o.update(parse_position(p))
        elif f == 3 and wt == 0: o["current_stop_sequence"] = p
        elif f == 4 and wt == 0: o["current_status"] = CURRENT_STATUS.get(p, p)
        elif f == 5 and wt == 0: o["timestamp"] = p
        elif f == 6 and wt == 0: o["congestion_level"] = CONGESTION.get(p, p)
        elif f == 7 and wt == 2: o["stop_id"] = s(p)
        elif f == 8 and wt == 2: o.update(parse_vehicle_desc(p))
        elif f == 9 and wt == 0: o["occupancy_status"] = OCCUPANCY.get(p, p)
    return o


def decode(buf: bytes) -> tuple[dict, list[dict]]:
    header, out = {}, []
    for f, wt, p in fields(buf):
        if f == 1 and wt == 2:
            for hf, hwt, hp in fields(p):
                if hf == 1 and hwt == 2: header["gtfs_realtime_version"] = s(hp)
                elif hf == 2 and hwt == 0: header["incrementality"] = hp
                elif hf == 3 and hwt == 0: header["timestamp"] = hp
        elif f == 2 and wt == 2:
            ent = {}
            for ef, ewt, ep in fields(p):
                if ef == 1 and ewt == 2: ent["entity_id"] = s(ep)
                elif ef == 4 and ewt == 2: ent.update(parse_vehicle_position(ep))
            if ent:
                out.append(ent)
    return header, out


def in_box(v: dict) -> bool:
    la, lo = v.get("lat"), v.get("lon")
    return (la is not None and lo is not None
            and BOX["w"] <= lo <= BOX["e"] and BOX["s"] <= la <= BOX["n"])


# ---------------------------------------------------------------- polling
def poll(key: str, timeout: int = 20) -> tuple[dict, list[dict], int]:
    url = f"{URL}?key={key}"
    req = urllib.request.Request(url, headers={
        "accept": "application/x-protobuf, application/octet-stream",
        "user-agent": "delhi-pulse-twin/0.1 (+pipeline)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        buf = r.read()
    h, v = decode(buf)
    return h, v, len(buf)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--key", default=os.environ.get("OTD_API_KEY", ""))
    ap.add_argument("--interval", type=int, default=20, help="seconds between polls")
    ap.add_argument("--minutes", type=float, default=0, help="0 = run until interrupted")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args()
    if not a.key:
        print("no OTD_API_KEY in the environment and no --key given", file=sys.stderr)
        return 2

    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    day = datetime.date.today().isoformat()
    nd = out / f"vehicles-{day}.ndjson"
    cov_path = out / f"coverage-{day}.json"

    # resume-safe: coverage accumulates across restarts, because a recorder that loses its audit
    # on a laptop lid-close is not much of an audit
    cov = {"polls": 0, "observations": 0, "in_box": 0, "empty_polls": 0, "errors": 0,
           "field_counts": {}, "value_counts": {}, "routes": {}, "vehicles": {},
           "first_poll": None, "last_poll": None, "feed_versions": {}}
    if cov_path.exists():
        try:
            cov.update(json.loads(cov_path.read_text()))
        except Exception:                                        # noqa: BLE001
            pass

    fc = collections.Counter(cov.get("field_counts", {}))
    vc = {k: collections.Counter(v) for k, v in cov.get("value_counts", {}).items()}
    routes = collections.Counter(cov.get("routes", {}))
    vehicles = collections.Counter(cov.get("vehicles", {}))
    versions = collections.Counter(cov.get("feed_versions", {}))

    ENUMS = ("current_status", "congestion_level", "occupancy_status", "schedule_relationship")
    deadline = None if (a.once or not a.minutes) else time.time() + a.minutes * 60
    print(f"  recording to {nd}   interval {a.interval}s   "
          f"{'one poll' if a.once else ('until interrupted' if not a.minutes else f'{a.minutes:g} min')}")

    def save_coverage():
        cov["field_counts"] = dict(fc)
        cov["value_counts"] = {k: dict(v) for k, v in vc.items()}
        cov["routes"] = dict(routes.most_common(400))
        cov["vehicles"] = dict(vehicles.most_common(2000))
        cov["feed_versions"] = dict(versions)
        cov["_note"] = ("field_counts is the number of vehicle observations carrying each field. "
                        "Divide by `observations` for the share. A field absent here is one Delhi "
                        "does not send, whatever the GTFS-Realtime spec permits.")
        cov_path.write_text(json.dumps(cov, indent=2) + "\n")

    try:
        while True:
            now = datetime.datetime.now().astimezone()
            try:
                h, vs, nbytes = poll(a.key)
            except KeyboardInterrupt:
                raise
            except Exception as e:                                   # noqa: BLE001
                # Deliberately broad. A recorder meant to run for eleven hours must survive every
                # transient a public endpoint can produce, and the first real run died four
                # minutes in on http.client.IncompleteRead — a truncated response, which is an
                # HTTPException and so slipped past a tuple of URLError/OSError/ValueError.
                # Enumerating exception types here is a losing game; the loop counts the failure,
                # sleeps and carries on.
                cov["errors"] += 1
                cov.setdefault("error_kinds", {})
                cov["error_kinds"][type(e).__name__] = \
                    cov["error_kinds"].get(type(e).__name__, 0) + 1
                print(f"  {now:%H:%M:%S}  poll failed: {type(e).__name__}: {e}")
                if a.once:
                    save_coverage(); return 1
                time.sleep(a.interval); continue

            cov["polls"] += 1
            cov["first_poll"] = cov["first_poll"] or now.isoformat()
            cov["last_poll"] = now.isoformat()
            versions[str(h.get("gtfs_realtime_version"))] += 1
            box = sum(1 for v in vs if in_box(v))
            cov["observations"] += len(vs)
            cov["in_box"] += box
            if not vs:
                cov["empty_polls"] += 1

            with nd.open("a") as fh:
                for v in vs:
                    for k in v:
                        fc[k] += 1
                    for k in ENUMS:
                        if k in v:
                            vc.setdefault(k, collections.Counter())[str(v[k])] += 1
                    if v.get("route_id"):
                        routes[v["route_id"]] += 1
                    if v.get("vehicle_id"):
                        vehicles[v["vehicle_id"]] += 1
                    rec = dict(v)
                    rec["_poll_at"] = now.isoformat()
                    rec["_feed_time"] = h.get("timestamp")
                    rec["_in_box"] = in_box(v)
                    fh.write(json.dumps(rec, separators=(",", ":")) + "\n")

            age = (int(time.time()) - h["timestamp"]) if h.get("timestamp") else None
            print(f"  {now:%H:%M:%S}  {len(vs):>5} vehicles  {box:>3} in box  "
                  f"{nbytes:>9,} B  feed age {age if age is not None else '?'}s")
            save_coverage()

            if a.once:
                break
            if deadline and time.time() >= deadline:
                break
            time.sleep(a.interval)
    except KeyboardInterrupt:
        print("\n  interrupted")

    save_coverage()
    obs = max(cov["observations"], 1)
    print(f"\n  polls {cov['polls']}  observations {cov['observations']}  "
          f"in box {cov['in_box']}  empty polls {cov['empty_polls']}  errors {cov['errors']}")
    if cov["observations"]:
        print("  field coverage (share of observations carrying the field):")
        for k, n in sorted(fc.items(), key=lambda kv: -kv[1]):
            print(f"    {k:26} {100 * n / obs:5.1f}%  ({n:,})")
        for k, c in vc.items():
            print(f"  {k}: " + ", ".join(f"{kk}={vv}" for kk, vv in c.most_common(6)))
        print(f"  distinct routes {len(routes)}   distinct vehicles {len(vehicles)}")
    else:
        print("  no vehicle observations yet — the feed publishes an empty message outside "
              "service hours, which is a real answer and not a failure.")
    print(f"  coverage written to {cov_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
