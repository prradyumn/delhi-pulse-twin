"""Second pipeline stage: the layers that make the box read as a place rather than a diagram.

Everything here is observed OSM geometry. The one synthesised thing in the whole detail pass —
avenue planting where OSM has no individual trees — is generated in this file, counted separately,
and labelled `simulated` in its own provenance so the UI can say which trees were surveyed.
"""
from __future__ import annotations
import json, collections, math, pathlib
from shapely.geometry import Polygon, LineString, Point
from shapely.ops import unary_union
from dpt.core import cfg, Proj, osm, write_json, provenance, osm_prov

C = cfg(); P = Proj(C); BOX = P.box()
MAIN = {"motorway", "trunk", "primary", "secondary", "tertiary"}


def _clip_line(pts):
    if len(pts) < 2:
        return []
    g = LineString(pts).intersection(BOX)
    if g.is_empty:
        return []
    parts = list(g.geoms) if g.geom_type == "MultiLineString" else [g]
    return [p for p in parts if p.geom_type == "LineString" and p.length > 3]


# ---------------------------------------------------------------- places to jump to
CATEGORY = [
    ("historic", None, "heritage"),
    ("tourism", {"attraction", "museum", "artwork", "viewpoint"}, "attraction"),
    ("amenity", {"place_of_worship"}, "worship"),
    ("amenity", {"marketplace"}, "market"),
    ("amenity", {"hospital", "university", "college", "library", "theatre", "embassy", "townhall"}, "civic"),
    ("office", {"government"}, "government"),
    ("railway", {"station"}, "station"),
    ("place", {"suburb", "neighbourhood", "quarter"}, "district"),
    ("landuse", {"retail"}, "market"),
]
# framing distance by category: a district needs altitude, a statue does not
FRAMING = {"district": 1500, "heritage": 320, "attraction": 340, "worship": 380,
           "market": 480, "civic": 460, "government": 420, "station": 400, "building": 380}


def places(manifest_assets, report):
    seen: dict[str, dict] = {}
    for el in osm("places"):
        t = el.get("tags", {})
        name = t.get("name") or t.get("name:en")
        if not name or len(name) < 3:
            continue
        cat = "building"
        for key, vals, label in CATEGORY:
            v = t.get(key)
            if v and (vals is None or v in vals):
                cat = label
                break
        c = el.get("center") or {"lat": el.get("lat"), "lon": el.get("lon")}
        if not c.get("lat"):
            continue
        x, z = P.xz(c["lon"], c["lat"])
        if not BOX.contains(Point(x, z)):
            continue
        # keep the richest record per name: heritage beats a bare named building
        rank = {"heritage": 0, "attraction": 1, "district": 2, "worship": 3, "station": 4,
                "government": 5, "civic": 6, "market": 7, "building": 8}
        prev = seen.get(name)
        if prev and rank[prev["cat"]] <= rank[cat]:
            continue
        seen[name] = {
            "id": f"place/{el['type'][0]}{el['id']}", "name": name, "cat": cat,
            "x": x, "z": z, "osm": f"{el['type']}/{el['id']}",
            "dist": FRAMING.get(cat, 400),
            "kind": t.get("historic") or t.get("tourism") or t.get("amenity")
                    or t.get("office") or t.get("railway") or t.get("place") or t.get("building"),
        }
    out = sorted(seen.values(), key=lambda p: (p["cat"], p["name"]))
    report["places"] = {"count": len(out), "by_cat": dict(collections.Counter(p["cat"] for p in out))}
    print(f"  {len(out)} places: {dict(collections.Counter(p['cat'] for p in out))}")
    manifest_assets["places"] = write_json("places.json", {
        "kind": "places", "count": len(out),
        "provenance": osm_prov(dataset="OSM named places, POIs, stations and districts",
            limitations=["Names and positions are observed OSM data. Framing distances are authored for this viewer.",
                         "Presence in this list reflects OSM coverage, not importance."]),
        "features": out}, minify=False)
    return out


# ---------------------------------------------------------------- trees
def trees(manifest_assets, report):
    observed = []
    for el in osm("trees"):
        t = el.get("tags", {})
        if el.get("lat"):
            pts = [(el["lon"], el["lat"])]
        elif el.get("geometry"):
            pts = [(g["lon"], g["lat"]) for g in el["geometry"]]
        else:
            continue
        # a tree_row is a line: plant along it at ~11 m centres, which is how avenues are spaced
        if len(pts) > 1:
            line = LineString([P.xz(lo, la) for lo, la in pts])
            n = max(int(line.length // 11), 1)
            samples = [line.interpolate(i / n, normalized=True) for i in range(n + 1)]
            coords = [(s.x, s.y) for s in samples]
        else:
            coords = [P.xz(*pts[0])]
        h = 0.0
        try:
            h = float(str(t.get("height", "")).replace("m", "").strip())
        except (ValueError, TypeError):
            h = 0.0
        for x, z in coords:
            if BOX.contains(Point(x, z)):
                observed.append([round(x, 1), round(z, 1), round(h, 1) if h else 0])

    # ---- avenue planting, generated. OSM has 1,087 individual trees in 16 km2; Lutyens' Delhi
    # actually has tens of thousands along its avenues. Without them the render cannot read as
    # this city, so they are generated here — counted apart and labelled simulated, never mixed
    # into the observed set.
    existing = unary_union([Point(x, z).buffer(9) for x, z, _ in observed]) if observed else None
    generated = []
    SPACING = {"primary": 13.0, "secondary": 14.0, "tertiary": 16.0, "trunk": 15.0, "motorway": 18.0}
    OFFSET = {"primary": 13.0, "secondary": 11.0, "tertiary": 9.0, "trunk": 14.0, "motorway": 16.0}
    for el in osm("highways"):
        t = el.get("tags", {}); hw = t.get("highway")
        if hw not in MAIN or not el.get("geometry"):
            continue
        for line in _clip_line(P.ring(el["geometry"])):
            step = SPACING.get(hw, 15.0)
            off = OFFSET.get(hw, 11.0)
            n = int(line.length // step)
            for i in range(n + 1):
                d = min(i * step, line.length)
                p0 = line.interpolate(max(d - 0.5, 0))
                p1 = line.interpolate(min(d + 0.5, line.length))
                dx, dz = p1.x - p0.x, p1.y - p0.y
                L = math.hypot(dx, dz) or 1
                nx, nz = dz / L, -dx / L
                base = line.interpolate(d)
                for side in (1, -1):
                    x = base.x + nx * off * side
                    z = base.y + nz * off * side
                    if not BOX.contains(Point(x, z)):
                        continue
                    if existing is not None and existing.contains(Point(x, z)):
                        continue     # do not double-plant where OSM already records a tree
                    generated.append([round(x, 1), round(z, 1)])

    report["trees"] = {"observed": len(observed), "generated": len(generated)}
    print(f"  trees: {len(observed):,} observed, {len(generated):,} generated avenue planting")
    manifest_assets["trees"] = write_json("trees.json", {
        "kind": "trees", "observed": len(observed), "generated": len(generated),
        "schema": "observed=[x,z,height_m or 0]; generated=[x,z]",
        "provenance": provenance(
            provider="OpenStreetMap contributors + derived",
            dataset="OSM natural=tree and tree_row, plus generated avenue planting",
            license="ODbL 1.0 for the observed trees; the generated planting is derived",
            attribution="© OpenStreetMap contributors",
            retrieved_at="2026-09-03", source_time=None,
            refresh_cadence="manual re-extract; pinned for the demo",
            mode="simulated",
            limitations=[
                f"{len(observed):,} trees are observed OSM records. {len(generated):,} are GENERATED at fixed spacing along main-road edges — they are visual context, not a survey, and no individual generated tree corresponds to a real tree.",
                "Generated planting is skipped within 9 m of an observed tree so the two never double up.",
                "Canopy size and height are stylised; only observed trees carry an OSM height tag, and most do not."]),
        "observed_trees": observed, "generated_trees": generated})


# ---------------------------------------------------------------- streetscape
def streetscape(manifest_assets, report):
    paths = []
    for el in osm("footways"):
        for line in _clip_line(P.ring(el.get("geometry") or [])):
            sp = line.simplify(1.2, preserve_topology=False)
            paths.append({"p": [[round(x, 1), round(z, 1)] for x, z in sp.coords],
                          "k": el.get("tags", {}).get("highway", "footway")})
    walls = []
    for el in osm("walls"):
        t = el.get("tags", {})
        for line in _clip_line(P.ring(el.get("geometry") or [])):
            sp = line.simplify(1.2, preserve_topology=False)
            h = 2.2 if t.get("barrier") == "wall" else (1.6 if t.get("barrier") == "hedge" else 1.4)
            walls.append({"p": [[round(x, 1), round(z, 1)] for x, z in sp.coords],
                          "k": t.get("barrier", "wall"), "h": h})
    report["streetscape"] = {"footways": len(paths), "walls": len(walls)}
    print(f"  streetscape: {len(paths)} footways, {len(walls)} walls/fences/hedges")
    manifest_assets["streetscape"] = write_json("streetscape.json", {
        "kind": "streetscape", "footways": len(paths), "walls": len(walls),
        "provenance": osm_prov(dataset="OSM footways, paths and barriers",
            limitations=["Wall and hedge heights are not tagged in OSM; 2.2 m for walls, 1.6 m for hedges and 1.4 m for fences are authored defaults.",
                         "Simplified at 1.2 m."]),
        "features": {"footways": paths, "walls": walls}})


# ---------------------------------------------------------------- building parts
def building_parts(manifest_assets, report):
    feats = []
    for el in osm("building_parts"):
        t = el.get("tags", {})
        pts = P.ring(el.get("geometry") or [])
        if len(pts) < 4:
            continue
        try:
            poly = Polygon(pts)
            if not poly.is_valid:
                poly = poly.buffer(0)
        except Exception:
            continue
        if poly.geom_type != "Polygon" or poly.area < 4 or not BOX.contains(poly.centroid):
            continue

        def num(key):
            try:
                return float(str(t.get(key, "")).replace("m", "").strip())
            except (ValueError, TypeError):
                return None
        h = num("height")
        lv = num("building:levels")
        if h is None and lv is not None:
            h = lv * C["height_rule"]["storey_m"]
        minh = num("min_height") or 0.0
        mlv = num("building:min_level")
        if not minh and mlv:
            minh = mlv * C["height_rule"]["storey_m"]
        if h is None or h <= minh:
            continue
        ring = [[round(x, 2), round(z, 2)] for x, z in list(poly.exterior.coords)[:-1]]
        feats.append({"id": f"bp/{el['type'][0]}{el['id']}", "r": ring,
                      "h": round(h, 1), "min": round(minh, 1),
                      "roof": t.get("roof:shape") or None})
    report["building_parts"] = {"count": len(feats)}
    print(f"  building parts: {len(feats)} with real heights")
    manifest_assets["building_parts"] = write_json("building-parts.json", {
        "kind": "building_parts", "count": len(feats),
        "schema": "r=ring; h=top height m; min=base height m — a stepped volume, not a prism",
        "provenance": osm_prov(dataset="OSM building:part volumes (Simple 3D Buildings)",
            limitations=["Only buildings whose contributors mapped 3D parts have them; most of the box does not.",
                         "Parts overlap their parent building footprint by design and are drawn on top of it."]),
        "features": feats})


# ---------------------------------------------------------------- bus route paths
def route_paths(manifest_assets, report, routes):
    """The actual ways each route traverses, stitched in relation member order.

    Without this, replay interpolates straight lines between stops and drives through buildings.
    """
    rel_geom = {}
    for el in osm("route_ways"):
        if el.get("type") != "relation":
            continue
        segs = []
        for m in el.get("members", []):
            if m.get("type") != "way" or not m.get("geometry") or m.get("role"):
                continue    # role="" is the itinerary; stop/platform roles are not path
            pts = P.ring(m["geometry"])
            if len(pts) >= 2:
                segs.append(pts)
        rel_geom[el["id"]] = segs

    out = []
    for r in routes:
        rid = int(r["osm"].split("/")[1])
        segs = rel_geom.get(rid, [])
        if not segs:
            print(f"  !! route {r['ref']}: no way geometry")
            out.append({**r, "path": [], "path_len": 0})
            continue
        # walk the members in order, flipping each so its start meets the running end
        path = list(segs[0])
        for seg in segs[1:]:
            end = path[-1]
            d_fwd = math.dist(end, seg[0])
            d_rev = math.dist(end, seg[-1])
            chunk = seg if d_fwd <= d_rev else seg[::-1]
            # a real gap means the relation is not continuous; keep going rather than guess
            path.extend(chunk[1:] if math.dist(path[-1], chunk[0]) < 30 else chunk)
        line = LineString(path)
        clipped = line.intersection(BOX)
        parts = list(clipped.geoms) if clipped.geom_type == "MultiLineString" else [clipped]
        parts = [p for p in parts if p.geom_type == "LineString" and p.length > 40]
        if not parts:
            out.append({**r, "path": [], "path_len": 0})
            continue
        best = max(parts, key=lambda p: p.length).simplify(1.5, preserve_topology=False)
        out.append({**r,
                    "path": [[round(x, 1), round(z, 1)] for x, z in best.coords],
                    "path_len": round(best.length, 1),
                    "path_segments_in_box": len(parts)})
        print(f"  route {r['ref']}: road path {best.length:,.0f} m from {len(segs)} member ways"
              f"{f' ({len(parts)} pieces in box, longest used)' if len(parts) > 1 else ''}")
    report["route_paths"] = [{"ref": o["ref"], "len": o["path_len"]} for o in out]
    return out
