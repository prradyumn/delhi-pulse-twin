#!/usr/bin/env python3
"""OSM extract -> versioned runtime data under web/public/data/@v1/.
Deterministic: same input, same transform_version, same bytes out."""
from __future__ import annotations
import json, collections, math, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from shapely.geometry import Polygon, LineString, Point
from shapely.ops import unary_union, linemerge
from dpt.core import cfg, Proj, osm, write_json, provenance, osm_prov, OUT, SNAP
from dpt.heights import resolve as resolve_height
from dpt import detail

C = cfg(); P = Proj(C)
BOX = P.box()
RULE = C["height_rule"]
CORR = {c["id"]: c for c in C["corridors"]}
MAIN = {"motorway", "trunk", "primary", "secondary", "tertiary"}
manifest_assets = {}
report = {}


def poly_of(el):
    pts = P.ring(el.get("geometry") or [])
    if len(pts) < 4:
        return None
    try:
        p = Polygon(pts)
        if not p.is_valid:
            p = p.buffer(0)
        return p if (p.geom_type == "Polygon" and p.area > 1) else None
    except Exception:
        return None


# ---------------------------------------------------------------- buildings
def buildings():
    feats = []; modes = collections.Counter(); bases = collections.Counter()
    dropped = 0
    for el in osm("buildings"):
        p = poly_of(el)
        if p is None:
            continue
        if not BOX.contains(p.centroid):     # kept or dropped whole — buildings are small
            dropped += 1
            continue
        # …except the few large ones (station canopies) that would hang past the edge
        bx = p.bounds
        if (bx[0] < -1997 or bx[2] > 1997 or bx[1] < -2073 or bx[3] > 2073):
            p = p.intersection(BOX)
            if p.is_empty or p.geom_type != "Polygon":
                dropped += 1
                continue
        t = el.get("tags", {})
        h, mode, basis = resolve_height(t, p.area, RULE)
        modes[mode] += 1; bases[basis] += 1
        # simplify lightly: 0.5 m tolerance removes surveyor noise, keeps corners
        s = p.simplify(0.5, preserve_topology=True)
        if s.is_empty or s.geom_type != "Polygon":
            s = p
        ring = [[round(x, 2), round(z, 2)] for x, z in list(s.exterior.coords)[:-1]]
        if len(ring) < 3:
            continue
        feats.append({
            "id": f"b/{el['type'][0]}{el['id']}",
            "r": ring, "h": h, "m": 0 if mode == "observed" else 1,
            "c": t.get("building", "yes"),
            "n": t.get("name") or None,
        })
    report["buildings"] = {"count": len(feats), "modes": dict(modes),
                           "dropped_outside_box": dropped,
                           "top_bases": dict(bases.most_common(6))}
    print(f"  {len(feats):,} kept, {dropped:,} dropped as outside the locked box")
    manifest_assets["buildings"] = write_json("buildings.json", {
        "kind": "buildings", "count": len(feats),
        "schema": "r=footprint ring [x,z] metres local; h=height m; m=0 observed 1 estimated",
        "height_rule_version": RULE["version"],
        "provenance": osm_prov(dataset="OSM buildings, box central-delhi-01",
            limitations=[
                f"{modes['estimated']} of {len(feats)} heights ({100*modes['estimated']/max(len(feats),1):.1f}%) are estimated by height rule v{RULE['version']}, not observed.",
                "Footprints simplified at 0.5 m tolerance.",
                "Courtyard holes in footprints are not modelled in V1."]),
        "features": feats})
    return feats


# ---------------------------------------------------------------- roads
def roads():
    feats = []; by_class = collections.Counter()
    corr_names = {c["osm_name"]: cid for cid, c in CORR.items()}
    for el in osm("highways"):
        t = el.get("tags", {}); hw = t.get("highway")
        g = el.get("geometry") or []
        if len(g) < 2:
            continue
        keep_minor = hw in ("residential", "unclassified", "service") and t.get("name")
        if hw not in MAIN and not keep_minor:
            continue
        line = LineString(P.ring(g))
        clipped = line.intersection(BOX)
        if clipped.is_empty:
            continue
        pieces = list(clipped.geoms) if clipped.geom_type == "MultiLineString" else [clipped]
        nm = t.get("name")
        for pi, piece in enumerate(pieces):
            if piece.geom_type != "LineString" or piece.length < 12:
                continue
            sp = piece.simplify(1.0, preserve_topology=False)
            by_class[hw] += 1
            feats.append({
                "id": f"r/w{el['id']}" + (f"#{pi}" if pi else ""),
                "p": [[round(x, 2), round(z, 2)] for x, z in sp.coords],
                "k": hw, "n": nm,
                "corridor": corr_names.get(nm),
                "lanes": int(t["lanes"]) if str(t.get("lanes", "")).isdigit() else None,
                "oneway": t.get("oneway") == "yes",
                "len": round(piece.length, 1),
            })
    report["roads"] = {"count": len(feats), "by_class": dict(by_class)}
    manifest_assets["roads"] = write_json("roads.json", {
        "kind": "roads", "count": len(feats),
        "schema": "p=centreline [x,z] metres local; k=osm highway class; corridor=hero corridor id or null",
        "provenance": osm_prov(dataset="OSM highways, box central-delhi-01",
            limitations=["Centrelines simplified at 1.0 m tolerance.",
                         "Dual carriageways remain separate ways — corridor metrics dedupe them, the render does not."]),
        "features": feats})
    return feats


# ---------------------------------------------------------------- corridors
def _snap(pts, grid=0.25):
    """Quantise coords so near-identical way endpoints actually merge."""
    return [(round(x / grid) * grid, round(z / grid) * grid) for x, z in pts]


def corridors(road_feats):
    """Built from RAW OSM geometry, never from the simplified render roads: roads() drops
    ways under 12 m and simplifies at 1 m, both of which break corridor continuity."""
    raw = osm("highways")
    out = []
    for cid, c in CORR.items():
        segs = []
        for el in raw:
            t = el.get("tags", {})
            if t.get("name") != c["osm_name"] or t.get("highway") not in MAIN:
                continue
            g = el.get("geometry") or []
            if len(g) < 2:
                continue
            clipped = LineString(P.ring(g)).intersection(BOX)
            if clipped.is_empty:
                continue
            for piece in (list(clipped.geoms) if clipped.geom_type == "MultiLineString" else [clipped]):
                if piece.geom_type != "LineString" or piece.length < 1:
                    continue
                pts = _snap(list(piece.coords))
                ded = [pts[0]] + [q for i, q in enumerate(pts[1:], 1) if q != pts[i - 1]]
                if len(ded) >= 2:
                    segs.append(LineString(ded))
        if not segs:
            print(f"  !! corridor {cid} produced no geometry"); continue
        merged = linemerge(segs)
        parts = list(merged.geoms) if merged.geom_type == "MultiLineString" else [merged]
        parts.sort(key=lambda g: -g.length)
        spine = parts[0]
        # segment the spine at ~150 m for per-segment traffic state
        step = 150.0; n = max(int(spine.length // step), 1)
        seg = []
        for i in range(n):
            a = spine.interpolate(i * spine.length / n)
            b = spine.interpolate((i + 1) * spine.length / n)
            seg.append({"i": i,
                        "a": [round(a.x, 2), round(a.y, 2)],
                        "b": [round(b.x, 2), round(b.y, 2)],
                        "len": round(spine.length / n, 1)})
        out.append({
            "id": cid, "label": c["label"], "role": c["role"], "layers": c["layers"],
            "no_transit_reason": c.get("no_transit_reason"),
            "spine": [[round(x, 2), round(z, 2)] for x, z in spine.coords],
            "spine_len": round(spine.length, 1),
            "chains": len(parts), "ways": len(segs),
            "segments": seg,
            "evidence": c["evidence"],
        })
        print(f"  corridor {cid}: spine {spine.length:.0f} m, {len(parts)} chain(s), {len(seg)} segments")
    report["corridors"] = [{"id": o["id"], "spine_len": o["spine_len"], "segments": len(o["segments"])} for o in out]
    manifest_assets["corridors"] = write_json("corridors.json", {
        "kind": "corridors", "count": len(out),
        "provenance": osm_prov(dataset="Hero corridor spines derived from OSM highways",
            mode="observed",
            limitations=["Spine is the longest merged chain of same-named main-class ways; shorter chains and service roads are excluded from metrics.",
                         "Segment length is a uniform ~150 m split, not an OSM segmentation."]),
        "features": out}, minify=False)
    return out


# ---------------------------------------------------------------- ground: landuse + water
def ground():
    keep = {"grass": "green", "garden": "green", "park": "green", "pitch": "pitch",
            "forest": "green", "meadow": "green", "recreation_ground": "green",
            "commercial": "urban", "retail": "urban", "residential": "urban",
            "industrial": "urban", "construction": "bare", "brownfield": "bare",
            "military": "urban", "religious": "urban", "cemetery": "green"}
    feats = []; cnt = collections.Counter()
    for el in osm("landuse"):
        t = el.get("tags", {})
        k = t.get("landuse") or t.get("leisure")
        cat = keep.get(k)
        if not cat:
            continue
        p = poly_of(el)
        if p is None:
            continue
        p = p.intersection(BOX)              # large polygons get cut at the boundary
        if p.is_empty:
            continue
        for part in (list(p.geoms) if p.geom_type == "MultiPolygon" else [p]):
            if part.geom_type != "Polygon" or part.area < 60:
                continue
            sp = part.simplify(2.0, preserve_topology=True)
            if sp.is_empty or sp.geom_type != "Polygon":
                sp = part
            cnt[cat] += 1
            feats.append({"id": f"g/{el['type'][0]}{el['id']}",
                          "r": [[round(x, 2), round(z, 2)] for x, z in list(sp.exterior.coords)[:-1]],
                          "cat": cat, "k": k, "n": t.get("name") or None,
                          "area": round(part.area)})
    feats.sort(key=lambda f: -f["area"])   # paint large first, small on top
    report["ground"] = {"count": len(feats), "by_cat": dict(cnt)}
    manifest_assets["ground"] = write_json("ground.json", {
        "kind": "ground", "count": len(feats),
        "schema": "r=ring [x,z]; cat=green|urban|pitch|bare. Painted largest-first so small polygons win.",
        "provenance": osm_prov(dataset="OSM landuse + leisure polygons",
            limitations=["Spike-0 measured 58.5% landuse coverage against 13.7% building coverage — this layer, not the buildings, carries the character of Lutyens' Delhi.",
                         "Polygons simplified at 2.0 m; overlaps are resolved by paint order, not by geometry."]),
        "features": feats})

    wf = []
    for el in osm("water"):
        t = el.get("tags", {})
        p = poly_of(el)
        if p is not None:
            p = p.intersection(BOX)
            for part in (list(p.geoms) if p.geom_type == "MultiPolygon" else [p]):
                if part.geom_type == "Polygon" and part.area > 40:
                    wf.append({"id": f"w/{el['type'][0]}{el['id']}", "kind": "area",
                               "r": [[round(x, 2), round(z, 2)] for x, z in list(part.exterior.coords)[:-1]],
                               "n": t.get("name") or None})
        elif el.get("geometry") and len(el["geometry"]) >= 2:
            ln = LineString(P.ring(el["geometry"])).intersection(BOX)
            for part in (list(ln.geoms) if ln.geom_type == "MultiLineString" else [ln]):
                if part.geom_type == "LineString" and part.length > 5:
                    wf.append({"id": f"w/{el['type'][0]}{el['id']}", "kind": "line",
                               "p": [[round(x, 2), round(z, 2)] for x, z in part.coords],
                               "n": t.get("name") or None})
    report["water"] = {"count": len(wf)}
    manifest_assets["water"] = write_json("water.json", {
        "kind": "water", "count": len(wf),
        "provenance": osm_prov(dataset="OSM natural=water + waterway"),
        "features": wf})


# ---------------------------------------------------------------- rail + metro
def rail():
    lines = []; stations = []
    for el in osm("rail"):
        t = el.get("tags", {})
        if t.get("railway") == "station":
            g = el.get("geometry") or []
            if g:
                x, z = P.xz(g[0]["lon"], g[0]["lat"])
            elif el.get("lon"):
                x, z = P.xz(el["lon"], el["lat"])
            else:
                continue
            if not BOX.contains(Point(x, z)):
                continue
            stations.append({"id": f"s/{el['type'][0]}{el['id']}", "x": x, "z": z,
                             "n": t.get("name") or "?",
                             "sub": t.get("station") == "subway" or t.get("subway") == "yes"})
        elif el.get("geometry") and len(el["geometry"]) >= 2:
            ln = LineString(P.ring(el["geometry"])).intersection(BOX)
            for pi, part in enumerate(list(ln.geoms) if ln.geom_type == "MultiLineString" else [ln]):
                if part.geom_type == "LineString" and part.length > 8:
                    lines.append({"id": f"rl/w{el['id']}" + (f"#{pi}" if pi else ""),
                                  "k": t.get("railway"),
                                  "p": [[round(x, 2), round(z, 2)] for x, z in part.coords]})
    # dedupe stations by name, keep first
    seen = set(); uniq = []
    for s in sorted(stations, key=lambda s: s["n"]):
        if s["n"] in seen:
            continue
        seen.add(s["n"]); uniq.append(s)
    report["rail"] = {"lines": len(lines), "stations": len(uniq)}
    manifest_assets["rail"] = write_json("rail.json", {
        "kind": "rail", "lines": len(lines), "stations": len(uniq),
        "provenance": osm_prov(dataset="OSM railway lines + stations",
            limitations=["Geographic context only. No live-train claim is made anywhere in this product.",
                         "Stations deduplicated by name; multi-entrance stations collapse to one point."]),
        "features": {"lines": lines, "stations": uniq}})


# ---------------------------------------------------------------- transit
def transit(corr):
    stops_el = osm("transit")
    stops = []
    for el in stops_el:
        t = el.get("tags", {})
        if el.get("lat"):
            x, z = P.xz(el["lon"], el["lat"])
        elif el.get("geometry"):
            g = el["geometry"][0]; x, z = P.xz(g["lon"], g["lat"])
        else:
            continue
        if not BOX.contains(Point(x, z)):
            continue
        stops.append({"id": f"p/{el['type'][0]}{el['id']}", "x": x, "z": z,
                      "n": t.get("name") or "Unnamed stop",
                      "osm": f"{el['type']}/{el['id']}"})
    by_osm = {s["osm"]: s for s in stops}

    rel = json.loads((pathlib.Path("spike/_raw/bus_routes_body.json")).read_text())["elements"]
    scores = json.loads(pathlib.Path("spike/results/bus_route_scores.json").read_text())
    # pick routes: highest stops_in_box, one per selected corridor, dedupe by ref
    spines = {c["id"]: LineString(c["spine"]).buffer(120) for c in corr if "transit" in c["layers"]}
    chosen = []; used_refs = set()
    cand = []
    for r in rel:
        t = r.get("tags", {}); ref = t.get("ref")
        mem = [f"{m['type']}/{m['ref']}" for m in r.get("members", [])]
        hit = [by_osm[m] for m in mem if m in by_osm]
        if not ref or len(hit) < 4:
            continue
        touch = {cid for cid, g in spines.items() if any(g.contains(Point(s["x"], s["z"])) for s in hit)}
        if touch:
            cand.append((len(touch), len(hit), ref, r, hit, sorted(touch)))
    cand.sort(key=lambda c: (-c[0], -c[1]))
    for _, nstops, ref, r, hit, touch in cand:
        if ref in used_refs or len(chosen) >= 3:
            continue
        used_refs.add(ref)
        # order stops along the route's own member sequence
        mem = [f"{m['type']}/{m['ref']}" for m in r.get("members", [])]
        ordered = [by_osm[m] for m in mem if m in by_osm]
        chosen.append({
            "id": f"route/{ref}", "ref": ref, "name": r["tags"].get("name", ref),
            "operator": r["tags"].get("operator", "Delhi Transport Corporation"),
            "osm": f"relation/{r['id']}",
            "corridors": touch,
            "stops": [{"id": s["id"], "n": s["n"], "x": s["x"], "z": s["z"]} for s in ordered],
            "assumed_headway_min": 12,
        })
    report["transit"] = {"stops": len(stops), "routes": [(c["ref"], len(c["stops"]), c["corridors"]) for c in chosen]}
    for c in chosen:
        print(f"  route {c['ref']}: {len(c['stops'])} in-box stops, corridors {c['corridors']}")

    # replace the straight stop-to-stop interpolation with the real road path per route
    chosen = detail.route_paths(manifest_assets, report, chosen)

    manifest_assets["transit"] = write_json("transit.json", {
        "kind": "transit", "stops": len(stops), "routes": len(chosen),
        "provenance": osm_prov(
            dataset="OSM bus stops/platforms + type=route,route=bus relations (Delhi Transport Corporation)",
            mode="observed",
            limitations=[
                "Route geometry and stop order come from OSM relations, NOT from GTFS. Delhi OTD static GTFS sits behind a usage-declaration form and its file host was unreachable on 2026-09-03; OTD realtime returns 401 without an authorised key.",
                "No schedule exists in this dataset. baseline headway of 12 min is an ASSUMPTION, not an observation, and every metric derived from it is labelled a proxy.",
                "Stop order follows the relation member sequence, which is community-maintained and may contain gaps.",
                "Each route carries the actual OSM ways it traverses as `path`, stitched in relation member order. Where a relation is discontinuous inside the box the longest continuous piece is used."]),
        "features": {"stops": stops, "routes": chosen}})
    return chosen


# ---------------------------------------------------------------- landmarks
def landmarks():
    """Hero-landmark footprints, resolved by verified OSM id. Relations arrive as member ways, so
    the outer ring is stitched here rather than trusting a top-level geometry key."""
    src = pathlib.Path("spike/_raw/osm_landmarks.json")
    meta = {lm["osm"]: lm for lm in C["landmarks"]["required"] + C["landmarks"]["optional"]}
    required = {lm["osm"] for lm in C["landmarks"]["required"]}
    feats = []
    if not src.exists():
        print("  !! spike/_raw/osm_landmarks.json missing — run: python pipeline/fetch_landmarks.py")
    else:
        for el in json.loads(src.read_text())["elements"]:
            key = f"{el['type']}/{el['id']}"
            lm = meta.get(key)
            if not lm:
                continue
            t = el.get("tags", {})
            rings = []
            if el.get("geometry"):
                rings.append(P.ring(el["geometry"]))
            for mem in el.get("members", []):
                if mem.get("type") == "way" and mem.get("geometry") and mem.get("role") in ("outer", "", None):
                    rings.append(P.ring(mem["geometry"]))
            polys = []
            for r in rings:
                if len(r) < 4:
                    continue
                try:
                    pp = Polygon(r)
                    if not pp.is_valid:
                        pp = pp.buffer(0)
                    if pp.geom_type == "Polygon" and pp.area > 4:
                        polys.append(pp)
                except Exception:
                    continue
            if not polys:
                print(f"  !! {lm['id']}: no usable ring from {key}")
                continue
            best = max(polys, key=lambda p: p.area)
            # height order: OSM tag (observed) -> published dimension (estimated) -> none
            h, hmode = lm.get("osm_height_m"), "observed"
            if h is None:
                try:
                    h = float(str(t.get("height", "")).replace("m", "").strip())
                except (ValueError, TypeError):
                    h = None
            if h is None and lm.get("assumed_height_m"):
                h, hmode = lm["assumed_height_m"], "estimated"
            if h is None:
                hmode = "estimated"
            feats.append({
                "id": lm["id"], "osm": key, "name": t.get("name") or lm["id"],
                "required": key in required,
                "ring": [[round(x, 2), round(z, 2)] for x, z in list(best.exterior.coords)[:-1]],
                # shapely holds our (x, z) pair as (x, y); z is the second component
                "centroid": [round(best.centroid.x, 2), round(best.centroid.y, 2)],
                "area_m2": round(best.area),
                "height_m": round(float(h), 1) if h is not None else None,
                "height_mode": hmode,
                "kind": lm.get("kind", "massing"),
                "serves": lm.get("serves"), "note": lm.get("note"),
            })
            print(f"  {lm['id']:<24} {feats[-1]['kind']:<8} {round(best.area):>7} m²  "
                  f"h={feats[-1]['height_m']} ({feats[-1]['height_mode']})  ({key})")

    report["landmarks"] = {"count": len(feats),
                           "required_present": sum(1 for f in feats if f["required"])}
    manifest_assets["landmarks"] = write_json("landmarks.json", {
        "kind": "landmarks", "count": len(feats),
        "provenance": osm_prov(
            dataset="OSM footprints for the verified hero landmarks",
            limitations=[
                "Footprints are observed OSM geometry. Heights come from OSM height tags where present and are otherwise estimated.",
                "Until the Phase 4 modelling sprint, kind=massing landmarks render as blocks extruded from the real footprint — correctly placed and scaled, deliberately not detailed.",
                "kind=open landmarks (Rajiv Chowk Central Park, Jantar Mantar) are open ground in OSM, not buildings. They render flat with a label: extruding the enclosure would misrepresent the site.",
                "India Gate's 42 m height is a published monument dimension, not an OSM tag, and is reported as estimated.",
            ]),
        "features": feats}, minify=False)
    return feats


# ---------------------------------------------------------------- weather + scenario model
def weather():
    manifest_assets["weather"] = write_json("weather/baseline.json", {
        "kind": "weather",
        "provenance": provenance(
            provider="Bundled snapshot (authored)", dataset="Pinned baseline weather scenario",
            license="n/a — authored for this prototype", attribution="Bundled baseline",
            retrieved_at="2026-09-03", source_time="2026-09-03T08:30:00+05:30",
            refresh_cadence="none — pinned", mode="observed",
            limitations=["A single pinned morning. Not a live observation and not a forecast.",
                         "Open-Meteo adapter may overlay this at runtime; when it does, mode and source_time change with it."]),
        "baseline": {"temp_c": 31.4, "rh_pct": 68, "wind_ms": 2.1,
                     "rain_mm_h": 0.0, "band": "none",
                     "label": "Weekday morning, 08:30 IST, dry"},
        "rain_bands": [
            {"id": "none", "label": "Dry", "mm_h": 0.0},
            {"id": "light", "label": "Light", "mm_h": 1.5, "imd": "< 2.5 mm/h"},
            {"id": "moderate", "label": "Moderate", "mm_h": 5.0, "imd": "2.5–7.6 mm/h"},
            {"id": "heavy", "label": "Heavy", "mm_h": 18.0, "imd": "7.6–35 mm/h"},
            {"id": "very_heavy", "label": "Very heavy", "mm_h": 45.0, "imd": "> 35 mm/h"}]})

    manifest_assets["scenario_model"] = write_json("scenario-model-0.1.json", {
        "version": "0.1",
        "shown_in_ui": True,
        "note": "Every weight and penalty on this page is displayed next to the number it produces. Changing one is a data change plus a version bump, never a silent code edit.",
        "free_flow_kmh": {"motorway": 60, "trunk": 50, "primary": 45,
                          "secondary": 35, "tertiary": 30, "residential": 20},
        "diurnal_congestion": {
            "_note": "Declared heuristic, hour 0-23, congestion index 0-1. Shaped to Delhi's twin weekday peaks. NOT calibrated against observed speeds — no open Delhi speed dataset was obtainable at build time, which is why this layer is labelled estimated everywhere it appears.",
            "profile": [0.05, 0.04, 0.04, 0.05, 0.08, 0.14, 0.24, 0.46,
                        0.68, 0.80, 0.62, 0.52, 0.50, 0.50, 0.52, 0.56,
                        0.62, 0.76, 0.88, 0.79, 0.55, 0.36, 0.21, 0.11]},
        "corridor_base": {
            "_note": "Per-corridor multiplier on the diurnal profile, reflecting the functional character Spike-0 measured rather than any observation.",
            "baba-kharak-singh-marg": 1.05,
            "barakhamba-road": 1.15,
            "kartavya-path": 0.62},
        "rain_speed_multiplier": {
            "_note": "Declared heuristic. Not calibrated against observed Delhi speeds — no such open dataset was available at build time.",
            "none":       {"primary": 1.00, "secondary": 1.00, "tertiary": 1.00},
            "light":      {"primary": 0.94, "secondary": 0.92, "tertiary": 0.90},
            "moderate":   {"primary": 0.84, "secondary": 0.80, "tertiary": 0.76},
            "heavy":      {"primary": 0.68, "secondary": 0.62, "tertiary": 0.56},
            "very_heavy": {"primary": 0.52, "secondary": 0.45, "tertiary": 0.38}},
        "msi_weights": {"speed_penalty": 0.45, "transit_pressure": 0.30, "weather_impact": 0.25},
        "wait_proxy": "half the headway, assuming evenly spaced arrivals",
        "transit_pressure_normalisation": "1 - (buses per hour / 12), clamped to 0-1. 12 buses/hour is treated as comfortable. A declared normalisation, not an observed crowding measure.",
        "definitions": {
            "mobility_stress_index": "Normalised composite of speed penalty, transit service pressure and weather impact for one corridor. A product-defined indicator, not a standard measure. Where a corridor has no transit at all, that weight is redistributed across the remaining terms and the UI says so.",
            "service_intensity": "Buses per hour = 60 / headway. Assumed headway, not scheduled or observed.",
            "wait_time_proxy": "Half the headway. Invalid for irregular arrivals; labelled a proxy.",
            "travel_time_index_proxy": "Scenario travel time / baseline travel time along the corridor spine.",
            "speed_penalty": "1 - (mean corridor speed / free-flow speed for the road class).",
        }})


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print("buildings…");  buildings()
    print("roads…");      rf = roads()
    print("corridors…");  cr = corridors(rf)
    print("ground…");     ground()
    print("rail…");       rail()
    print("landmarks…");  landmarks()
    print("places…");     detail.places(manifest_assets, report)
    print("trees…");      detail.trees(manifest_assets, report)
    print("streetscape…"); detail.streetscape(manifest_assets, report)
    print("building parts…"); detail.building_parts(manifest_assets, report)
    print("transit…");    transit(cr)
    print("weather + scenario model…"); weather()

    total = sum(a["bytes"] for a in manifest_assets.values())
    man = {
        "dataset_version": "v1",
        "transform_version": C["transform_version"],
        "built_at": "2026-09-03",
        "study_area": C["study_area"],
        "tiles": C["tiles"],
        "corridors": [{"id": c["id"], "label": c["label"], "role": c["role"],
                       "layers": c["layers"], "no_transit_reason": c.get("no_transit_reason")}
                      for c in cr],
        "landmarks": C["landmarks"],
        "height_rule": C["height_rule"],
        "budgets": C["budgets"],
        "assets": manifest_assets,
        "total_uncompressed_bytes": total,
        "attribution": ["© OpenStreetMap contributors (ODbL 1.0)",
                        "Bus routes from OpenStreetMap route relations, operator Delhi Transport Corporation",
                        "Weather baseline authored for this prototype"],
        "health": {"live_adapters": [], "note": "No live provider is required. Every layer here is bundled."},
    }
    write_json("manifest.json", man, minify=False)
    SNAP.mkdir(parents=True, exist_ok=True)
    (SNAP / "build-report.json").write_text(json.dumps(report, indent=2))

    print("\n=== output ===")
    for k, a in sorted(manifest_assets.items(), key=lambda kv: -kv[1]["bytes"]):
        print(f"  {k:<16} {a['bytes']/1024:>9.1f} KB  {a['path']}")
    print(f"  {'TOTAL':<16} {total/1024:>9.1f} KB uncompressed")


if __name__ == "__main__":
    main()
