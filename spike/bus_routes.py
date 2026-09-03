#!/usr/bin/env python3
"""Spike-0 deliverable 2 (revised): score OSM bus route relations instead of GTFS.
GTFS static sits behind a usage-declaration form; OSM route relations are ODbL and already cleared."""
import json,urllib.request,urllib.parse,collections,pathlib,time
RAW=pathlib.Path("spike/_raw"); RES=pathlib.Path("spike/results")
OV=["https://overpass-api.de/api/interpreter","https://overpass.kumi.systems/api/interpreter"]

def q(query,cache):
    p=RAW/cache
    if p.exists() and p.stat().st_size>200: return json.loads(p.read_text())
    d=urllib.parse.urlencode({"data":query}).encode()
    for h in OV:
        try:
            r=urllib.request.Request(h,data=d,headers={"User-Agent":"delhi-pulse-twin/spike-0"})
            raw=urllib.request.urlopen(r,timeout=420).read()
            p.write_bytes(raw); return json.loads(raw)
        except Exception as e:
            print(f"  {h.split('/')[2]}: {e}"); time.sleep(12)
    raise SystemExit("overpass unavailable")

# in-box stop/platform ids
tr=json.load(open(RAW/"osm_transit.json"))["elements"]
inbox={(e["type"],e["id"]) for e in tr}
names={(e["type"],e["id"]): e.get("tags",{}).get("name","?") for e in tr}
print(f"in-box stop/platform elements: {len(inbox)}")

# relation bodies (members, no geometry — geometry for whole-city routes would be huge)
data=q('''[out:json][timeout:300];
relation["type"="route"]["route"="bus"](28.6039,77.1975,28.6401,77.2385);
out body;''',"bus_routes_body.json")
rels=data["elements"]
print(f"bus route relations: {len(rels)}")

# corridor proximity: which corridor does a stop sit near?
from pyproj import Transformer
from shapely.geometry import LineString, Point
from shapely.ops import unary_union
T=Transformer.from_crs("EPSG:4326","EPSG:32643",always_xy=True)
hw=json.load(open(RAW/"osm_highways.json"))["elements"]
CORR={"kartavya-path":"Kartavya Path","barakhamba-road":"Barakhamba Road","janpath":"Janpath"}
corr_geom={}
for cid,nm in CORR.items():
    segs=[LineString([T.transform(p["lon"],p["lat"]) for p in e["geometry"]])
          for e in hw if e.get("tags",{}).get("name")==nm and e.get("geometry")
          and e["tags"].get("highway") in ("secondary","tertiary","primary","trunk","residential")
          and len(e["geometry"])>=2]
    corr_geom[cid]=unary_union(segs).buffer(120)   # 120 m catchment
stop_pt={}
for e in tr:
    if e["type"]=="node" and e.get("lat"): stop_pt[(e["type"],e["id"])]=Point(T.transform(e["lon"],e["lat"]))
    elif e.get("geometry"):
        g=e["geometry"]; stop_pt[(e["type"],e["id"])]=Point(T.transform(g[0]["lon"],g[0]["lat"]))

rows=[]
for r in rels:
    t=r.get("tags",{})
    mem=[(m["type"],m["ref"]) for m in r.get("members",[]) if m.get("role","").startswith(("stop","platform")) or m["type"]=="node"]
    hit=[m for m in mem if m in inbox]
    if not hit: continue
    touched=set()
    for m in hit:
        p=stop_pt.get(m)
        if p is None: continue
        for cid,g in corr_geom.items():
            if g.contains(p): touched.add(cid)
    rows.append({"rel":r["id"],"ref":t.get("ref","-"),"name":t.get("name","-"),
                 "operator":t.get("operator","-"),"stops_in_box":len(hit),
                 "corridors":sorted(touched),"n_corridors":len(touched),
                 "stop_names":[names[m] for m in hit[:6]]})
rows.sort(key=lambda x:(-x["n_corridors"],-x["stops_in_box"]))
print(f"\nroutes with >=1 stop in box: {len(rows)}")
print(f"{'ref':<9}{'stops':>6}{'corr':>6}  corridors touched                 name")
for r in rows[:22]:
    print(f"{r['ref']:<9}{r['stops_in_box']:>6}{r['n_corridors']:>6}  {','.join(r['corridors'])[:32]:<32} {r['name'][:44]}")
cov=collections.Counter()
for r in rows:
    for c in r["corridors"]: cov[c]+=1
print("\nroutes per corridor:",dict(cov))
RES.mkdir(parents=True,exist_ok=True)
json.dump(rows,open(RES/"bus_route_scores.json","w"),indent=2)
