#!/usr/bin/env python3
"""Invariants the runtime data must satisfy. Run after `make data`:

    .venv/bin/python pipeline/tests/test_outputs.py

These are the properties that broke silently during Spike-0 and would break silently again:
geometry escaping the locked bounds, a corridor fragmenting, provenance going missing, a height
mode disagreeing with its own rule. No test framework — a plain script keeps this runnable with
nothing installed beyond the pipeline's own two dependencies.
"""
from __future__ import annotations
import json, sys, pathlib, math

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "web" / "public" / "data" / "@v1"
CONFIG = json.loads((ROOT / "config" / "study-area.json").read_text())

failures: list[str] = []
checks = 0


def check(cond: bool, msg: str):
    global checks
    checks += 1
    if not cond:
        failures.append(msg)
    return cond


def load(name: str):
    p = OUT / name
    if not p.exists():
        failures.append(f"{name} is missing — run `make data`")
        return None
    return json.loads(p.read_text())


# ---------------------------------------------------------------- bounds
ex = CONFIG["study_area"]["runtime_extent"]
X0, X1 = ex["x"]
Z0, Z1 = ex["z"]
# buildings are kept or dropped whole by centroid, so they may hang a little past the edge;
# everything else is clipped exactly. See docs/06-SPIKE-0-BAKEOFF.md.
TOL = {"buildings.json": 60.0, "landmarks.json": 60.0}


def points_of(payload, ring_key, line_key):
    for f in payload.get("features", []) if isinstance(payload.get("features"), list) else []:
        for k in (ring_key, line_key):
            if k and isinstance(f.get(k), list):
                for pt in f[k]:
                    yield pt


def bounds_check(name, ring_key="r", line_key="p"):
    payload = load(name)
    if payload is None:
        return
    tol = TOL.get(name, 1.5)
    bad = 0
    n = 0
    for x, z in points_of(payload, ring_key, line_key):
        n += 1
        if not (math.isfinite(x) and math.isfinite(z)):
            bad += 1
            continue
        if x < X0 - tol or x > X1 + tol or z < Z0 - tol or z > Z1 + tol:
            bad += 1
    check(n > 0, f"{name}: no coordinates found")
    check(bad == 0, f"{name}: {bad} of {n} vertices fall outside the locked bounds (tolerance {tol} m)")


for nm in ("buildings.json", "roads.json", "ground.json", "water.json"):
    bounds_check(nm)

# ---------------------------------------------------------------- provenance on every layer
REQUIRED_PROV = ("provider", "dataset", "license", "attribution", "retrieved_at",
                 "bounds", "crs", "mode", "transform_version", "limitations")
VALID_MODES = {"observed", "estimated", "simulated", "replay"}

for nm in ("buildings.json", "roads.json", "ground.json", "water.json", "rail.json",
           "transit.json", "corridors.json"):
    payload = load(nm)
    if payload is None:
        continue
    prov = payload.get("provenance")
    if not check(isinstance(prov, dict), f"{nm}: no provenance record"):
        continue
    missing = [k for k in REQUIRED_PROV if k not in prov or prov[k] in (None, "")]
    check(not missing, f"{nm}: provenance missing {missing}")
    check(prov.get("mode") in VALID_MODES, f"{nm}: mode {prov.get('mode')!r} is not a valid data mode")
    check(prov.get("transform_version") == CONFIG["transform_version"],
          f"{nm}: transform_version {prov.get('transform_version')} != config {CONFIG['transform_version']}")

# ---------------------------------------------------------------- buildings + height rule
b = load("buildings.json")
if b:
    feats = b["features"]
    check(len(feats) > 2500, f"buildings: only {len(feats)} features — expected ~3,200")
    check(b.get("height_rule_version") == CONFIG["height_rule"]["version"],
          "buildings: height_rule_version does not match config")
    bad_h = [f["id"] for f in feats if not (1.0 <= f["h"] <= 300)]
    check(not bad_h, f"buildings: {len(bad_h)} implausible heights, e.g. {bad_h[:3]}")
    bad_m = [f["id"] for f in feats if f["m"] not in (0, 1)]
    check(not bad_m, f"buildings: {len(bad_m)} bad height-mode flags")
    short = [f["id"] for f in feats if len(f["r"]) < 3]
    check(not short, f"buildings: {len(short)} rings with fewer than 3 vertices")
    dup = len(feats) - len({f["id"] for f in feats})
    check(dup == 0, f"buildings: {dup} duplicate ids")

    est = sum(1 for f in feats if f["m"] == 1)
    pct = 100 * est / max(len(feats), 1)
    measured = CONFIG["measured"]["height_or_levels_tag_pct"]
    # the estimated share must stay consistent with what Spike-0 measured; a big move means the
    # rule or the extract changed and the disclosure copy is now wrong
    check(abs((100 - pct) - measured) < 3.0,
          f"buildings: {pct:.1f}% estimated implies {100 - pct:.1f}% tagged, but config records {measured}%")
    print(f"  buildings: {len(feats):,} features, {pct:.1f}% estimated heights")

# ---------------------------------------------------------------- corridors
c = load("corridors.json")
if c:
    cs = c["features"]
    cfg_ids = {x["id"] for x in CONFIG["corridors"]}
    check({x["id"] for x in cs} == cfg_ids,
          f"corridors: {sorted(x['id'] for x in cs)} != config {sorted(cfg_ids)}")
    for x in cs:
        check(len(x["spine"]) >= 2, f"corridor {x['id']}: spine has {len(x['spine'])} points")
        check(x["spine_len"] > 300, f"corridor {x['id']}: spine only {x['spine_len']} m")
        check(len(x["segments"]) >= 2, f"corridor {x['id']}: {len(x['segments'])} segments")
        # segment ends must chain: b of segment i equals a of segment i+1
        breaks = sum(1 for i in range(len(x["segments"]) - 1)
                     if math.dist(x["segments"][i]["b"], x["segments"][i + 1]["a"]) > 1.0)
        check(breaks == 0, f"corridor {x['id']}: {breaks} gaps between consecutive segments")
        cfg = next(y for y in CONFIG["corridors"] if y["id"] == x["id"])
        check(x["layers"] == cfg["layers"], f"corridor {x['id']}: layers disagree with config")
        if "transit" not in cfg["layers"]:
            check(bool(x.get("no_transit_reason")),
                  f"corridor {x['id']} has no transit layer but states no reason — the UI needs one")
        print(f"  corridor {x['id']:<26} {x['spine_len']:>7.0f} m, {len(x['segments'])} segments, {x['chains']} chain(s)")

# ---------------------------------------------------------------- transit
t = load("transit.json")
if t:
    stops = t["features"]["stops"]
    routes = t["features"]["routes"]
    check(len(stops) > 100, f"transit: only {len(stops)} stops")
    check(1 <= len(routes) <= 3, f"transit: {len(routes)} routes selected, expected 1-3")
    for r in routes:
        check(len(r["stops"]) >= 4, f"route {r['ref']}: only {len(r['stops'])} in-box stops")
        check(r["assumed_headway_min"] > 0, f"route {r['ref']}: non-positive assumed headway")
        check(bool(r["corridors"]), f"route {r['ref']}: touches no hero corridor")
    lim = " ".join(t["provenance"]["limitations"]).lower()
    check("assum" in lim, "transit: provenance must state that headway is assumed, not observed")
    check("gtfs" in lim, "transit: provenance must record why GTFS is not the source")
    print(f"  transit: {len(stops)} stops, routes {[r['ref'] for r in routes]}")

# ---------------------------------------------------------------- scenario model
sm = load("scenario-model-0.1.json")
if sm:
    prof = sm["diurnal_congestion"]["profile"]
    check(len(prof) == 24, f"scenario model: diurnal profile has {len(prof)} hours, expected 24")
    check(all(0 <= v <= 1 for v in prof), "scenario model: diurnal values must be 0-1")
    w = sm["msi_weights"]
    check(abs(sum(w.values()) - 1.0) < 1e-6, f"scenario model: MSI weights sum to {sum(w.values())}, expected 1.0")
    for band, table in sm["rain_speed_multiplier"].items():
        if band.startswith("_"):
            continue
        check(all(0 < v <= 1 for v in table.values()),
              f"scenario model: rain multipliers for {band} must be in (0, 1]")
    check(sm["rain_speed_multiplier"]["none"]["secondary"] == 1.0,
          "scenario model: the dry band must not alter speed")
    for cid in {x["id"] for x in CONFIG["corridors"]}:
        check(cid in sm["corridor_base"], f"scenario model: no corridor_base entry for {cid}")

# ---------------------------------------------------------------- manifest
mf = load("manifest.json")
if mf:
    check(mf["study_area"]["status"] == "LOCKED", "manifest: study area is not LOCKED")
    check(mf["health"]["live_adapters"] == [],
          "manifest: a live adapter is declared — the MVP must require none")
    check(bool(mf["attribution"]), "manifest: no attribution list")
    check(any("OpenStreetMap" in a for a in mf["attribution"]),
          "manifest: ODbL attribution for OpenStreetMap is required")
    total_kb = mf["total_uncompressed_bytes"] / 1024
    gate_mb = CONFIG["budgets"]["initial_transfer_mb"]["hard_gate"]
    check(total_kb / 1024 < gate_mb, f"manifest: {total_kb / 1024:.2f} MB uncompressed exceeds the {gate_mb} MB gate")
    print(f"  manifest: {total_kb:.0f} KB uncompressed across {len(mf['assets'])} assets")

# ---------------------------------------------------------------- report
print()
if failures:
    print(f"  FAILED — {len(failures)} of {checks} checks")
    for f in failures:
        print(f"    - {f}")
    sys.exit(1)
print(f"  all {checks} data invariants hold")
