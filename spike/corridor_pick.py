#!/usr/bin/env python3
"""Which candidate corridors actually carry buses? Decides the final corridor set."""
import json,pathlib,collections
from pyproj import Transformer
from shapely.geometry import LineString, Point
from shapely.ops import unary_union, linemerge
RAW=pathlib.Path("spike/_raw"); RES=pathlib.Path("spike/results")
T=Transformer.from_crs("EPSG:4326","EPSG:32643",always_xy=True)
hw=json.load(open(RAW/"osm_highways.json"))["elements"]
tr=json.load(open(RAW/"osm_transit.json"))["elements"]
rels=json.load(open(RAW/"bus_routes_body.json"))["elements"]

CAND=["Kartavya Path","Barakhamba Road","Janpath","Sansad Marg","Ashoka Road",
      "Copernicus Marg","Tolstoy Marg","Baba Kharak Singh Marg","Panchkuian Road",
      "Maulana Azad Road","Shahjahan Road","Akbar Road","Mandir Marg","Ranjit Singh Marg"]
MAIN={"primary","trunk","secondary","tertiary"}

inbox={(e["type"],e["id"]) for e in tr}
pt={}
for e in tr:
    if e["type"]=="node" and e.get("lat"): pt[(e["type"],e["id"])]=Point(T.transform(e["lon"],e["lat"]))
    elif e.get("geometry"): g=e["geometry"]; pt[(e["type"],e["id"])]=Point(T.transform(g[0]["lon"],g[0]["lat"]))

rows=[]
for nm in CAND:
    segs=[]; classes=set(); lanes=[]
    for e in hw:
        t=e.get("tags",{})
        if t.get("name")!=nm or not e.get("geometry") or len(e["geometry"])<2: continue
        if t.get("highway") not in MAIN: continue
        segs.append(LineString([T.transform(p["lon"],p["lat"]) for p in e["geometry"]]))
        classes.add(t["highway"])
        if t.get("lanes","").isdigit(): lanes.append(int(t["lanes"]))
    if not segs: rows.append((nm,0,0,0,0,0,set(),0)); continue
    merged=linemerge(segs)
    parts=list(merged.geoms) if merged.geom_type=="MultiLineString" else [merged]
    longest=max(p.length for p in parts)
    catch=unary_union(segs).buffer(120)
    stops=[m for m in inbox if m in pt and catch.contains(pt[m])]
    routes=set()
    for r in rels:
        mem=[(m["type"],m["ref"]) for m in r.get("members",[])]
        if any(m in stops for m in mem): routes.add(r.get("tags",{}).get("ref","?"))
    rows.append((nm,len(segs),sum(s.length for s in segs),longest,len(parts),
                 len(stops),classes,len(routes)))

rows.sort(key=lambda r:-r[7])
print(f"{'corridor':<24}{'ways':>5}{'total m':>9}{'longest':>9}{'chains':>7}{'stops':>7}{'routes':>8}  classes")
for nm,nw,tot,lo,ch,st,cl,rt in rows:
    print(f"{nm:<24}{nw:>5}{tot:>9.0f}{lo:>9.0f}{ch:>7}{st:>7}{rt:>8}  {','.join(sorted(cl))}")
json.dump([{"name":r[0],"ways":r[1],"total_m":r[2],"longest_chain_m":r[3],"chains":r[4],
            "stops_in_catchment":r[5],"classes":sorted(r[6]),"distinct_bus_refs":r[7]} for r in rows],
          open(RES/"corridor_pick.json","w"),indent=2)
