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
    # three modes since height rule v0.2: 0 observed from an OSM tag, 2 measured from satellite,
    # 1 estimated by class rule
    bad_m = [f["id"] for f in feats if f["m"] not in (0, 1, 2)]
    check(not bad_m, f"buildings: {len(bad_m)} bad height-mode flags")
    short = [f["id"] for f in feats if len(f["r"]) < 3]
    check(not short, f"buildings: {len(short)} rings with fewer than 3 vertices")
    dup = len(feats) - len({f["id"] for f in feats})
    check(dup == 0, f"buildings: {dup} duplicate ids")

    obs = sum(1 for f in feats if f["m"] == 0)
    rs = sum(1 for f in feats if f["m"] == 2)
    est = sum(1 for f in feats if f["m"] == 1)
    pct = 100 * est / max(len(feats), 1)
    check(obs + rs + est == len(feats),
          f"buildings: mode counts {obs}+{rs}+{est} do not sum to {len(feats)}")

    # The OSM-tagged share is what Spike-0 measured, and it is the only one of the three that
    # should be stable: it is a property of the extract, not of our estimators. Before v0.2 this
    # was inferred as 100 - estimated, which stopped being true the moment a third mode existed —
    # the check now reads the observed count directly, which is what it always meant.
    measured = CONFIG["measured"]["height_or_levels_tag_pct"]
    obs_pct = 100 * obs / max(len(feats), 1)
    check(abs(obs_pct - measured) < 3.0,
          f"buildings: {obs_pct:.1f}% carry an OSM height tag, but config records {measured}%")

    rule = CONFIG["height_rule"]
    if rule["version"] != "0.1":
        # v0.2 exists to get the box off an authored guess. If the satellite tier silently stops
        # contributing — raster missing, gate too strict, coordinates wrong — the build still
        # succeeds and every height quietly reverts to the rule. This is the check that notices.
        check(rs > len(feats) * 0.5,
              f"buildings: height rule v{rule['version']} declares a satellite tier but only "
              f"{rs} of {len(feats)} heights came from it — the raster or the gate is broken")
        check(pct < 20.0,
              f"buildings: {pct:.1f}% of heights still come from the class rule under "
              f"v{rule['version']}; v0.1 was 91.8% and the point of v0.2 is that most are measured")
        rsm = rule.get("remote_sensed", {})
        check(bool(rsm.get("attribution")) and bool(rsm.get("licence")),
              "height_rule.remote_sensed must carry the dataset licence and attribution")
        m = rsm.get("measured_against_osm", {})
        check(m.get("satellite_mae_m", 99) < m.get("rule_v0_1_mae_m", 0),
              "height_rule records a satellite MAE no better than the rule it replaced — if that "
              "is really so, the satellite tier should not be above the rule")
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

# ---------------------------------------------------------------- detail pass
tr = load("trees.json")
if tr:
    obs, gen = tr["observed_trees"], tr["generated_trees"]
    check(len(obs) == tr["observed"], "trees: observed count disagrees with the array")
    check(len(gen) == tr["generated"], "trees: generated count disagrees with the array")
    check(len(obs) > 800, f"trees: only {len(obs)} observed")
    # the honesty requirement: the split must be stated, because most trees here are generated
    lim = " ".join(tr["provenance"]["limitations"]).lower()
    check("generated" in lim, "trees: provenance must say that most trees are generated")
    check(tr["provenance"]["mode"] == "simulated",
          "trees: mode must be simulated while generated planting is included")
    bad = sum(1 for x, z, *_ in obs + [(*g, 0) for g in gen]
              if x < X0 - 2 or x > X1 + 2 or z < Z0 - 2 or z > Z1 + 2)
    check(bad == 0, f"trees: {bad} outside the locked bounds")
    print(f"  trees: {len(obs):,} observed + {len(gen):,} generated")

pl = load("places.json")
if pl:
    ps = pl["features"]
    check(len(ps) > 200, f"places: only {len(ps)}")
    check(all(p.get("name") and p.get("cat") and p.get("dist") for p in ps),
          "places: every entry needs a name, category and framing distance")
    bad = [p["id"] for p in ps if p["x"] < X0 or p["x"] > X1 or p["z"] < Z0 or p["z"] > Z1]
    check(not bad, f"places: {len(bad)} outside the locked bounds")
    print(f"  places: {len(ps)} across {len({p['cat'] for p in ps})} categories")

bp = load("building-parts.json")
if bp:
    check(all(f["h"] > f["min"] for f in bp["features"]),
          "building parts: a part must be taller than its own base height")

for r in (t["features"]["routes"] if (t := load("transit.json")) else []):
    check(len(r.get("path", [])) > 3,
          f"route {r['ref']}: no road path — replay would cut straight lines between stops")
    check(r.get("path_len", 0) > 500, f"route {r['ref']}: road path only {r.get('path_len')} m")

mt = load("metro.json")
if mt:
    lines = mt["features"]
    check(len(lines) >= 3, f"metro: only {len(lines)} lines")
    for l in lines:
        # not a vertex-count check: the Airport Express line runs nearly straight through the
        # box, so 2 m simplification legitimately leaves it 5 points. Length is the invariant.
        check(len(l["path"]) >= 2, f"metro {l['name']}: path has {len(l['path'])} points")
        check(l["path_len"] > 300, f"metro {l['name']}: only {l['path_len']} m in box")
        # DMRC's own colours, so a bare default would mean the tag was missing
        check(l["colour"].startswith("#") and len(l["colour"]) == 7,
              f"metro {l['name']}: colour {l['colour']!r} is not a hex triplet")
        check(all(0 <= d <= l["path_len"] for d in l["station_at"]),
              f"metro {l['name']}: a station sits off the end of its own path")
        check(l["station_at"] == sorted(l["station_at"]),
              f"metro {l['name']}: stations are not ordered along the path")
    lim = " ".join(mt["provenance"]["limitations"]).lower()
    check("live" in lim, "metro: provenance must state that movement is not a live position")
    print(f"  metro: {len(lines)} lines, "
          + ", ".join(f"{l['name'].split()[0]} {l['path_len']:.0f} m" for l in lines))

ss = load("streetscape.json")
if ss:
    fw = ss["features"]["footways"]
    check(len(fw) > 500, f"streetscape: only {len(fw)} footways — pedestrians need paths to walk")
    check(all(len(f["p"]) >= 2 for f in fw), "streetscape: a footway with fewer than 2 points")

# landmark index: the honesty state of every landmark asset must be explicit
li = OUT / "landmarks" / "index.json"
if not li.exists():
    failures.append("landmarks/index.json missing — run `make assets`")
else:
    idx = json.loads(li.read_text())["landmarks"]
    VALID_SOURCE = {"blend", "parametric", "placeholder", "open_ground"}
    lmf = {f["id"]: f for f in (load("landmarks.json") or {"features": []})["features"]}
    for lid, e in idx.items():
        check(e["source"] in VALID_SOURCE,
              f"landmark {lid}: source {e['source']!r} is not a declared honesty state")
        if e["source"] == "open_ground":
            check(e["lods"] == [], f"landmark {lid}: open ground must ship no model")
            check(lmf.get(lid, {}).get("kind") == "open",
                  f"landmark {lid}: index says open_ground but landmarks.json does not")
        else:
            check(sorted(e["lods"]) == [0, 1, 2], f"landmark {lid}: LODs {e['lods']}, expected 0,1,2")
    # every buildable landmark must be accounted for, or the UI silently omits one
    buildable = {i for i, f in lmf.items() if f.get("kind") != "open"}
    check(buildable <= set(idx), f"landmark index is missing {sorted(buildable - set(idx))}")
    by_src = {}
    for e in idx.values():
        by_src[e["source"]] = by_src.get(e["source"], 0) + 1
    print(f"  landmarks: {by_src}")

# ------------------------------------------------- no building inside an authored landmark
#
# The bug this exists to catch was invisible in every number and obvious in one render: India
# Gate's arch is separately mapped in OSM as `way/1078065894`, a 40 m building distinct from the
# monument way the landmark config names. The buildings layer extruded it, with the office-facade
# texture, exactly on top of the authored model. Excluding by OSM id could never have caught it.
_lm = load("landmarks.json")
_bl = load("buildings.json")
if _lm and _bl:
    def _inside(pt, ring):
        # ray casting; the rings here are simple polygons straight out of shapely
        x, z = pt
        inside = False
        n = len(ring)
        for i in range(n):
            ax, az = ring[i]
            bx, bz = ring[(i + 1) % n]
            if (az > z) != (bz > z):
                t = (z - az) / (bz - az)
                if x < ax + t * (bx - ax):
                    inside = not inside
        return inside

    modelled = [f for f in _lm["features"] if f["kind"] != "open"]
    overlaps = []
    for b in _bl["features"]:
        ring = b["r"]
        cx = sum(p[0] for p in ring) / len(ring)
        cz = sum(p[1] for p in ring) / len(ring)
        for lm in modelled:
            if _inside((cx, cz), lm["ring"]):
                overlaps.append(f"{b['id']} (h={b['h']}) inside {lm['id']}")
                break
    check(not overlaps,
          f"{len(overlaps)} building footprint(s) sit inside an authored landmark and will render "
          f"through it: {overlaps[:4]}")
    # and the suppression must actually have run rather than the overlap merely not existing
    rep = json.loads((pathlib.Path("snapshots/v1/build-report.json")).read_text()) \
        if pathlib.Path("snapshots/v1/build-report.json").exists() else {}
    sup = (rep.get("buildings") or {}).get("suppressed_under_landmarks")
    if sup is not None:
        check(sum(sup.values()) > 0,
              "no buildings were suppressed under landmarks — the spatial exclusion is not running")
        print(f"  landmark overlap: {sum(sup.values())} building(s) suppressed {sup}")

# ---------------------------------------------------------------- manifest
mf = load("manifest.json")
if mf:
    check(mf["study_area"]["status"] == "LOCKED", "manifest: study area is not LOCKED")
    # The scope lock says no live provider may be REQUIRED — not that none may exist. Listing an
    # adapter is fine; depending on one is not. So the property to assert is that everything a
    # live adapter feeds has a bundled fallback to fall back to.
    adapters = mf["health"]["live_adapters"]
    check(isinstance(adapters, list), "manifest: health.live_adapters must be a list")
    wx = load("weather/baseline.json")
    if any("weather" in a for a in adapters):
        check(bool(wx and wx.get("baseline")),
              "a live weather adapter is enabled but there is no pinned weather baseline to fall back to")
    if any("air" in a for a in adapters):
        check(bool(wx and wx.get("air_baseline")),
              "a live air-quality adapter is enabled but there is no pinned air baseline to fall back to")
    # Anything needing a key must stay off in the COMMITTED CONFIG, or a clone without the key
    # fires requests that can only fail — a console error for every user. The generated manifest
    # may still enable one, but only when the build environment supplied the credential, and it
    # has to name the variable it found. So the rule is checked against the config file, and the
    # manifest is required to justify any difference.
    cfgp = pathlib.Path("config/study-area.json")
    if cfgp.exists():
        committed = json.loads(cfgp.read_text()).get("live_adapters", {})
        keyed_committed = [k for k, v in committed.items() if k.startswith("otd_") and v is True]
        check(not keyed_committed,
              f"adapters requiring a key are enabled in the committed config: {keyed_committed}. "
              f"Leave them false — `make data` enables them from the environment instead.")
    from_env = mf["health"].get("live_adapters_from_env") or []
    env_named = {e.get("adapter") for e in from_env if isinstance(e, dict)}
    for a in adapters:
        if not a.startswith("otd_"):
            continue
        check(a in env_named,
              f"manifest enables {a}, which needs a credential, but does not record the environment "
              f"variable that turned it on")
    for e in from_env:
        check(isinstance(e, dict) and e.get("variable"),
              f"live_adapters_from_env entry names no variable: {e!r}")
    extra = f" (+{sorted(env_named)} from the environment)" if env_named else ""
    print(f"  live adapters: {adapters or 'none'} (all with bundled fallbacks){extra}")
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
