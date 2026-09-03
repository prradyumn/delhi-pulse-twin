#!/usr/bin/env python3
"""Spike-0: full geometry download for the winning candidate box. Stdlib only."""
import json, urllib.request, urllib.parse, time, pathlib, sys
OVERPASS="https://overpass-api.de/api/interpreter"
RAW=pathlib.Path(__file__).parent/"_raw"; RAW.mkdir(parents=True,exist_ok=True)
BBOX=(28.6039,77.1975,28.6401,77.2385)   # S,W,N,E  — box A
b="%.4f,%.4f,%.4f,%.4f"%BBOX

QUERIES={
 "buildings": f'nwr["building"]({b});',
 "highways":  f'way["highway"]({b});',
 "water":     f'( nwr["natural"="water"]({b}); way["waterway"]({b}); );',
 "rail":      f'( way["railway"~"^(rail|subway|light_rail)$"]({b}); nwr["railway"="station"]({b}); );',
 "landuse":   f'( nwr["landuse"]({b}); nwr["leisure"~"^(park|garden|pitch)$"]({b}); );',
 "transit":   f'( node["highway"="bus_stop"]({b}); nwr["public_transport"="platform"]({b}); );',
}
def fetch(name,sel):
    out=RAW/f"osm_{name}.json"
    if out.exists() and out.stat().st_size>200:
        print(f"  {name}: cached {out.stat().st_size/1e6:.1f} MB"); return
    q=f"[out:json][timeout:300];\n{sel}\nout geom;"
    data=urllib.parse.urlencode({"data":q}).encode()
    req=urllib.request.Request(OVERPASS,data=data,
        headers={"User-Agent":"delhi-pulse-twin/spike-0 (portfolio prototype)"})
    t=time.time()
    for attempt in (1,2,3):
        try:
            with urllib.request.urlopen(req,timeout=600) as r: raw=r.read()
            out.write_bytes(raw)
            n=len(json.loads(raw)["elements"])
            print(f"  {name}: {n:,} elements, {len(raw)/1e6:.1f} MB, {time.time()-t:.1f}s"); return
        except Exception as e:
            print(f"  {name}: attempt {attempt} failed ({e})"); time.sleep(12)
    print(f"  {name}: GAVE UP")
for k,v in QUERIES.items():
    print(f"fetching {k}"); fetch(k,v); time.sleep(4)
