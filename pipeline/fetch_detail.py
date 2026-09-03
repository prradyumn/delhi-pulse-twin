#!/usr/bin/env python3
"""Second data pass: what the scene needs to stop looking like a diagram.

  route_ways  - the actual OSM ways each selected bus route traverses, so replay follows roads
                instead of cutting straight lines between stops through buildings
  trees       - 1,087 surveyed trees. Lutyens' Delhi is defined by its tree-lined avenues and a
                render without them will never read as this city
  footways    - paths through the parks and plazas
  walls       - compound walls, which is how the bungalow zone is actually divided
"""
import json, urllib.request, urllib.parse, pathlib, time, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "spike" / "_raw"
OV = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
B = "28.6039,77.1975,28.6401,77.2385"


def fetch(name, query):
    out = RAW / f"osm_{name}.json"
    if out.exists() and out.stat().st_size > 200:
        print(f"  {name}: cached {out.stat().st_size/1e6:.2f} MB")
        return
    data = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(4):
        for host in OV:
            try:
                r = urllib.request.Request(host, data=data,
                    headers={"User-Agent": "delhi-pulse-twin/detail-pass"})
                raw = urllib.request.urlopen(r, timeout=420).read()
                out.write_bytes(raw)
                print(f"  {name}: {len(json.loads(raw)['elements']):,} elements, {len(raw)/1e6:.2f} MB")
                return
            except Exception as e:
                print(f"    {host.split('/')[2]}: {e}")
                time.sleep(10)
    sys.exit(f"could not fetch {name}")


routes = json.loads((ROOT / "web/public/data/@v1/transit.json").read_text())["features"]["routes"]
rel_ids = [r["osm"].split("/")[1] for r in routes]
print(f"selected routes: {[r['ref'] for r in routes]} -> relations {rel_ids}")

fetch("route_ways", "[out:json][timeout:300];\n(" +
      "".join(f"relation({rid});" for rid in rel_ids) + ");\nout geom;")
fetch("trees", f'''[out:json][timeout:300];
( node["natural"="tree"]({B}); way["natural"="tree_row"]({B}); );
out geom;''')
fetch("footways", f'''[out:json][timeout:300];
way["highway"~"^(footway|path|pedestrian|steps)$"]({B});
out geom;''')
fetch("walls", f'''[out:json][timeout:300];
way["barrier"~"^(wall|fence|hedge)$"]({B});
out geom;''')

# ---- second wave: places to jump to, and real 3D building detail
fetch("places", f'''[out:json][timeout:300];
(
  nwr["historic"]({B});
  nwr["tourism"~"^(attraction|museum|artwork|viewpoint)$"]({B});
  nwr["amenity"~"^(place_of_worship|marketplace|hospital|university|college|library|theatre|embassy|townhall)$"]({B});
  nwr["office"="government"]["name"]({B});
  nwr["building"]["name"]({B});
  nwr["railway"="station"]({B});
  nwr["place"~"^(suburb|neighbourhood|quarter)$"]({B});
  nwr["landuse"="retail"]["name"]({B});
);
out tags center;''')

fetch("building_parts", f'''[out:json][timeout:300];
nwr["building:part"]({B});
out geom;''')

# ---- metro line routes, with their official DMRC colours from OSM
# one relation per line (each line has a relation per direction; trains run both ways from one path)
fetch("metro_routes", '''[out:json][timeout:300];
(
  relation(447209);    /* Blue Line            #4169E1 */
  relation(447210);    /* Yellow Line          #FFDF00 */
  relation(2535797);   /* Violet Line          #553592 */
  relation(2535798);   /* Airport Express Line #FF8C00 */
);
out geom;''')
