"""Shared config, projection and provenance for the Delhi Pulse Twin pipeline."""
from __future__ import annotations
import json, pathlib, hashlib, datetime, subprocess
from pyproj import Transformer

ROOT = pathlib.Path(__file__).resolve().parents[3]
CONFIG = ROOT / "config" / "study-area.json"
RAW = ROOT / "spike" / "_raw"
OUT = ROOT / "web" / "public" / "data" / "@v1"
SNAP = ROOT / "snapshots" / "v1"


def cfg() -> dict:
    return json.loads(CONFIG.read_text())


class Proj:
    """WGS84 -> EPSG:32643 -> local metres, with the Three.js axis mapping applied once, here."""

    def __init__(self, c: dict):
        sa = c["study_area"]
        self.t = Transformer.from_crs(sa["crs_storage"], sa["crs_projected"], always_xy=True)
        o = sa["local_origin_utm"]
        self.ox, self.oy = o["easting"], o["northing"]
        self.w, self.h = sa["measured_extent_m"]
        w, s, e, n = sa["bbox_wgs84"]
        (self.x0, self.z1), (self.x1, self.z0) = self.xz(w, s), self.xz(e, n)

    def box(self):
        """The clip rectangle in runtime coordinates. Overpass hands back complete ways, so
        without this the scene extends hundreds of metres past the locked bounds."""
        from shapely.geometry import box as _box
        return _box(self.x0, self.z0, self.x1, self.z1)

    def xz(self, lon: float, lat: float) -> tuple[float, float]:
        """Return (x, z) in Three.js convention: +X east, +Z south."""
        e, n = self.t.transform(lon, lat)
        return round(e - self.ox, 2), round(-(n - self.oy), 2)

    def ring(self, geometry) -> list[list[float]]:
        return [list(self.xz(p["lon"], p["lat"])) for p in geometry if p]


def osm(name: str) -> list[dict]:
    return json.loads((RAW / f"osm_{name}.json").read_text())["elements"]


def provenance(**kw) -> dict:
    """Every dataset carries one of these. Missing fields are a bug, not an omission."""
    base = {
        "provider": None, "dataset": None, "license": None, "attribution": None,
        "retrieved_at": None, "source_time": None, "refresh_cadence": None,
        "bounds": cfg()["study_area"]["bbox_wgs84"], "crs": "EPSG:32643 + local origin",
        "mode": None, "transform_version": cfg()["transform_version"], "limitations": [],
    }
    base.update(kw)
    missing = [k for k in ("provider", "dataset", "license", "attribution", "mode") if not base[k]]
    if missing:
        raise ValueError(f"provenance missing required fields: {missing}")
    return base


OSM_PROV = dict(
    provider="OpenStreetMap contributors",
    dataset="OSM Overpass extract, box central-delhi-01",
    license="ODbL 1.0 (https://www.openstreetmap.org/copyright)",
    attribution="© OpenStreetMap contributors",
    retrieved_at="2026-09-03",
    refresh_cadence="manual re-extract; pinned for the demo",
    mode="observed",
)


def write_json(rel: str, obj, *, minify=True) -> dict:
    p = OUT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(obj, separators=(",", ":")) if minify else json.dumps(obj, indent=2)
    p.write_text(txt)
    b = txt.encode()
    return {"path": f"data/@v1/{rel}", "bytes": len(b),
            "sha256": hashlib.sha256(b).hexdigest()[:16]}


def osm_prov(**over) -> dict:
    """Provenance for an OSM-derived dataset: the shared OSM fields with per-dataset overrides."""
    d = dict(OSM_PROV)
    d.update(over)
    return provenance(**d)
