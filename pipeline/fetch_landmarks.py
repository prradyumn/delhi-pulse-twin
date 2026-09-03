#!/usr/bin/env python3
"""Fetch the verified hero-landmark footprints by OSM id.

These cannot come from the buildings extract: India Gate is tagged historic=monument rather than
building, and the relation-backed ones (Old Parliament House, Rashtrapati Bhavan, North/South
Block) are multipolygons that `nwr["building"]; out geom;` does not return usable geometry for.
Spike-0 resolved every id by name query — see docs/06-SPIKE-0-RESULTS.md.
"""
import json, urllib.request, urllib.parse, pathlib, sys, time

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "spike" / "_raw"
CONFIG = ROOT / "config" / "study-area.json"
OV = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]


def main():
    cfg = json.loads(CONFIG.read_text())
    lms = cfg["landmarks"]["required"] + cfg["landmarks"]["optional"]

    clauses = []
    for lm in lms:
        kind, oid = lm["osm"].split("/")
        clauses.append(f"{kind}({oid});")
    query = "[out:json][timeout:180];\n(\n  " + "\n  ".join(clauses) + "\n);\nout geom;"

    out = RAW / "osm_landmarks.json"
    if out.exists() and out.stat().st_size > 200:
        print(f"cached: {out} ({out.stat().st_size / 1024:.1f} KB)")
        return

    data = urllib.parse.urlencode({"data": query}).encode()
    for host in OV:
        try:
            req = urllib.request.Request(host, data=data,
                headers={"User-Agent": "delhi-pulse-twin/pipeline (portfolio prototype)"})
            raw = urllib.request.urlopen(req, timeout=300).read()
            RAW.mkdir(parents=True, exist_ok=True)
            out.write_bytes(raw)
            els = json.loads(raw)["elements"]
            print(f"fetched {len(els)} landmark elements -> {out}")
            for e in els:
                t = e.get("tags", {})
                geo = "way" if e.get("geometry") else ("relation" if e.get("members") else "none")
                print(f"  {e['type']}/{e['id']:<12} {t.get('name', '?')[:34]:<34} geom={geo} h={t.get('height', '-')}")
            return
        except Exception as exc:
            print(f"  {host.split('/')[2]}: {exc}")
            time.sleep(10)
    sys.exit("overpass unavailable for landmark fetch")


if __name__ == "__main__":
    main()
