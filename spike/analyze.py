#!/usr/bin/env python3
"""Spike-0: deep audit of the winning box — density, height coverage, corridor continuity."""
import json, pathlib, collections, math
from pyproj import Transformer
from shapely.geometry import Polygon, LineString, shape
from shapely.ops import unary_union, linemerge

RAW=pathlib.Path("spike/_raw"); RES=pathlib.Path("spike/results")
BBOX_WSEN=(77.1975,28.6039,77.2385,28.6401)
T=Transformer.from_crs("EPSG:4326","EPSG:32643",always_xy=True)

def load(n): return json.load(open(RAW/f"osm_{n}.json"))["elements"]

def ring(el):
    g=el.get("geometry") or []
    pts=[T.transform(p["lon"],p["lat"]) for p in g if p]
    return pts

def poly(el):
    pts=ring(el)
    if len(pts)<4: return None
    try:
        p=Polygon(pts)
        if not p.is_valid: p=p.buffer(0)
        return p if (p.area>1 and not p.is_empty) else None
    except Exception: return None

# ---- box metrics
w,s,e,n=BBOX_WSEN
x0,y0=T.transform(w,s); x1,y1=T.transform(e,n)
box_area=(x1-x0)*(y1-y0)
print(f"box: {(x1-x0):.0f} x {(y1-y0):.0f} m = {box_area/1e6:.2f} km²")
print(f"UTM 43N origin (SW corner): {x0:.2f}, {y0:.2f}")
print(f"UTM 43N centre            : {(x0+x1)/2:.2f}, {(y0+y1)/2:.2f}")

# ---- buildings
bl=load("buildings")
polys=[]; heights=collections.Counter(); levels=[]; areas=[]
tagged=0
for el in bl:
    p=poly(el)
    if p is None: continue
    polys.append(p); areas.append(p.area)
    t=el.get("tags",{})
    if "height" in t or "building:levels" in t: tagged+=1
    if "building:levels" in t:
        try: levels.append(float(str(t["building:levels"]).split(";")[0]))
        except Exception: pass
    heights[t.get("building","yes")]+=1
built=unary_union(polys)
print(f"\nbuildings: {len(bl):,} elements -> {len(polys):,} usable polygons")
print(f"  density            : {len(polys)/(box_area/1e6):.0f} footprints / km²")
print(f"  footprint coverage : {100*built.area/box_area:.1f}% of the box")
print(f"  median footprint   : {sorted(areas)[len(areas)//2]:.0f} m²  mean {sum(areas)/len(areas):.0f} m²")
print(f"  height/levels tag  : {tagged:,} ({100*tagged/len(polys):.1f}%)")
if levels:
    ls=sorted(levels); print(f"  levels: median {ls[len(ls)//2]:.0f}, p90 {ls[int(.9*len(ls))]:.0f}, max {ls[-1]:.0f}")
print("  top building= values:", dict(heights.most_common(6)))
tri_est=sum(max(len(p.exterior.coords)-1,3) for p in polys)*2*2  # walls+roof rough
print(f"  rough triangle estimate for all footprints: {tri_est:,}")

# ---- landuse mass (what fills the visual gap)
lu=load("landuse"); lup=collections.Counter(); lupoly=[]
for el in lu:
    p=poly(el)
    t=el.get("tags",{})
    k=t.get("landuse") or t.get("leisure") or "?"
    lup[k]+=1
    if p is not None: lupoly.append((k,p))
tot=unary_union([p for _,p in lupoly]) if lupoly else None
print(f"\nlanduse/leisure: {len(lu)} elements, coverage {100*tot.area/box_area:.1f}%" if tot else "")
print("  top classes:", dict(lup.most_common(8)))

# ---- corridor continuity
hw=load("highways")
by_name=collections.defaultdict(list)
for el in hw:
    t=el.get("tags",{}); nm=t.get("name")
    if not nm: continue
    pts=ring(el)
    if len(pts)>=2: by_name[nm].append((LineString(pts), t.get("highway"), t.get("lanes"), t.get("oneway")))
print("\ncorridor continuity (merged from named ways):")
for nm in ["Kartavya Path","Barakhamba Road","Janpath","Sansad Marg","Ashoka Road","Copernicus Marg","Tolstoy Marg"]:
    segs=by_name.get(nm,[])
    if not segs: print(f"  {nm:<18} ABSENT"); continue
    merged=linemerge([g for g,_,_,_ in segs])
    parts=list(merged.geoms) if merged.geom_type=="MultiLineString" else [merged]
    total=sum(g.length for g,_,_,_ in segs)
    longest=max(p.length for p in parts)
    classes=sorted({c for _,c,_,_ in segs if c})
    print(f"  {nm:<18} {len(segs):>3} ways  {total:>6.0f} m total  {len(parts)} chain(s)  longest {longest:>5.0f} m  {classes}")

# ---- transit
tr=load("transit")
print(f"\ntransit stop nodes/platforms in box: {len(tr)}")
named=[e for e in tr if e.get("tags",{}).get("name")]
print(f"  with a name: {len(named)}")

# ---- rail
rl=load("rail")
st=[e for e in rl if e.get("tags",{}).get("railway")=="station"]
print(f"rail: {len(rl)} elements, {len(st)} stations: {sorted({e['tags'].get('name','?') for e in st})[:8]}")

RES.mkdir(parents=True,exist_ok=True)
json.dump({"utm_origin_sw":[x0,y0],"utm_centre":[(x0+x1)/2,(y0+y1)/2],
           "box_m":[x1-x0,y1-y0],
           "buildings_usable":len(polys),"density_per_km2":len(polys)/(box_area/1e6),
           "footprint_coverage_pct":100*built.area/box_area,
           "height_tag_pct":100*tagged/len(polys),
           "rough_triangles":tri_est},
          open(RES/"deep_audit.json","w"),indent=2)
