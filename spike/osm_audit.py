#!/usr/bin/env python3
"""Spike-0 deliverable 1: OSM completeness audit across candidate study boxes.
Stdlib only. Uses Overpass `out count` so each candidate costs one cheap query."""
import json, urllib.request, urllib.parse, time, sys, pathlib

OVERPASS = "https://overpass-api.de/api/interpreter"
RAW = pathlib.Path(__file__).parent / "_raw"
RES = pathlib.Path(__file__).parent / "results"

# (south, west, north, east) — Overpass bbox order
CANDIDATES = {
    "A_proposed":     (28.6039, 77.1975, 28.6401, 77.2385),
    "B_north_ndls":   (28.6139, 77.1975, 28.6501, 77.2385),
    "C_east_purana":  (28.6039, 77.2175, 28.6401, 77.2585),
}

CORRIDORS = ["Kartavya Path", "Barakhamba Road", "Janpath", "Sansad Marg", "Ashoka Road",
             "Copernicus Marg", "Ferozeshah Road", "Tolstoy Marg", "Rajpath"]
LANDMARKS = ["India Gate", "Sansad Bhavan", "Rashtrapati Bhavan", "Jantar Mantar",
             "National Museum", "Parliament House"]

def build_query(bbox):
    b = "%.4f,%.4f,%.4f,%.4f" % bbox
    parts = [f"[out:json][timeout:180];"]
    def cnt(sel, label):
        parts.append(f"{sel}({b})->.s; .s out count;")
        labels.append(label)
    labels = []
    cnt('nwr["building"]',                                    "buildings_total")
    cnt('nwr["building"]["height"]',                          "buildings_height_tag")
    cnt('nwr["building"]["building:levels"]',                 "buildings_levels_tag")
    cnt('way["highway"]',                                     "highway_ways_all")
    cnt('way["highway"~"^(motorway|trunk|primary|secondary)$"]', "highway_major")
    cnt('way["highway"="tertiary"]',                          "highway_tertiary")
    cnt('way["highway"~"^(residential|service|unclassified)$"]', "highway_minor")
    cnt('nwr["natural"="water"]',                             "water_bodies")
    cnt('way["waterway"]',                                    "waterways")
    cnt('way["railway"~"^(rail|subway|light_rail)$"]',        "railway_ways")
    cnt('nwr["railway"="station"]',                           "rail_stations")
    cnt('nwr["public_transport"="platform"]',                 "pt_platforms")
    cnt('nwr["highway"="bus_stop"]',                          "bus_stops")
    for c in CORRIDORS:
        cnt(f'way["highway"]["name"="{c}"]', f"corridor::{c}")
    for l in LANDMARKS:
        cnt(f'nwr["name"="{l}"]', f"landmark::{l}")
    return "\n".join(parts), labels

def run(bbox, name):
    q, labels = build_query(bbox)
    cache = RAW / f"audit_{name}.json"
    if cache.exists():
        print(f"  [{name}] cached"); return json.loads(cache.read_text()), labels
    data = urllib.parse.urlencode({"data": q}).encode()
    req = urllib.request.Request(OVERPASS, data=data,
          headers={"User-Agent": "delhi-pulse-twin/spike-0 (portfolio prototype; contact pradyumn)"})
    t = time.time()
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = json.loads(r.read().decode())
    print(f"  [{name}] {len(raw.get('elements',[]))} count objects in {time.time()-t:.1f}s")
    cache.write_text(json.dumps(raw))
    return raw, labels

def main():
    RAW.mkdir(parents=True, exist_ok=True); RES.mkdir(parents=True, exist_ok=True)
    out = {}
    for name, bbox in CANDIDATES.items():
        print(f"querying {name} {bbox}")
        try:
            raw, labels = run(bbox, name)
        except Exception as e:
            print(f"  FAILED: {e}"); out[name] = {"error": str(e)}; continue
        counts = {}
        for lab, el in zip(labels, raw.get("elements", [])):
            tags = el.get("tags", {})
            counts[lab] = int(tags.get("total", tags.get("ways", 0) or 0))
        out[name] = {"bbox_swne": bbox, "counts": counts}
        time.sleep(3)
    (RES / "osm_audit.json").write_text(json.dumps(out, indent=2))
    print(f"\nwrote {RES/'osm_audit.json'}")

if __name__ == "__main__":
    main()
