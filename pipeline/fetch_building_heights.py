#!/usr/bin/env python3
"""Fetch satellite-derived building heights for the study box, by HTTP range request.

**Why this exists.** 91.8% of building heights in this box are estimated by a class-based rule, and
that rule is load-bearing: it sets every skyline in the render and every shadow. Checking it against
the 261 buildings that DO carry an OSM height tag showed the errors are not uniform — most classes
land within a storey, and `apartments` is out by **+38.5 m**, a factor of 3.75. Central Delhi's
`apartments` are high-rise blocks; the rule assumed a four-storey walk-up.

Calibrating the rule on those 261 is tempting and wrong: OSM contributors tag heights on tall and
notable buildings preferentially, so that sample is selection-biased upward (its p90 is 45.5 m,
which is not central Delhi). Fitting to it would bake the bias in. An independent source with no
such bias is the only honest fix.

**The source.** Google Research Open Buildings 2.5D Temporal v1: per-pixel `building_height` rasters
from Sentinel-2, annual 2016-2023, ~4 m effective resolution, published mean absolute error 1.5 m.
Licensed CC-BY 4.0 **and ODbL 1.0** — the same licence as the OSM geometry it will be joined to.

**Why a hand-written reader.** The tiles are 1.0-1.6 GB each and three of them overlap this box:
3.7 GB to answer a question about 16 km². But they are internally tiled GeoTIFFs — 512x512, DEFLATE,
float32, and already in **EPSG:32643**, the exact CRS this project projects to — so the study box is
about 256 internal tiles per file and can be range-read directly. That is roughly 1% of the bytes,
needs no Earth Engine account, and adds no GDAL dependency to a pipeline that deliberately runs on
pyproj and shapely alone (ADR-008).

Two format details that are easy to get wrong and silent when you do:
  - PlanarConfig=2 (separate planes), so band 1 `building_height` is tile indices 2401..4801, not
    an interleaved sample. Reading plane 0 would return fractional building COUNT and look
    plausible.
  - Predictor=3, the floating-point predictor: per row, a cumulative byte sum, then a byte-plane
    de-shuffle that is endian-dependent. Skipping it yields noise; skipping only the de-shuffle
    yields numbers in roughly the right range, which is worse.

Usage:
  python pipeline/fetch_building_heights.py [--year 2023] [--out spike/_raw/heights]
"""
from __future__ import annotations
import argparse, json, math, pathlib, struct, sys, urllib.error, urllib.request, zlib

import numpy as np

BUCKET = "https://storage.googleapis.com/open-buildings-temporal-data"
MANIFEST = f"{BUCKET}/v1/manifests"
GEOTIFFS = f"{BUCKET}/v1/geotiffs"
BAND_NAME = "building_height"
NODATA = -99.0

TYPESZ = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}


def get(url: str, start: int | None = None, end: int | None = None, timeout=120) -> bytes:
    req = urllib.request.Request(url, headers={"user-agent": "delhi-pulse-twin/0.1 (+pipeline)"})
    if start is not None:
        req.add_header("Range", f"bytes={start}-{end}")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- minimal tiled-GeoTIFF reader
class Tiff:
    """Just enough classic little-endian TIFF to range-read tiles out of a remote COG."""

    def __init__(self, url: str, header_bytes: int = 262144):
        self.url = url
        self.hdr = get(url, 0, header_bytes - 1)
        if self.hdr[:2] != b"II" or struct.unpack("<H", self.hdr[2:4])[0] != 42:
            raise SystemExit(f"{url}: not a classic little-endian TIFF")
        self.tags = self._read_ifd(struct.unpack("<I", self.hdr[4:8])[0])

        self.width = self._scalar(256)
        self.length = self._scalar(257)
        self.tw = self._scalar(322)
        self.tl = self._scalar(323)
        self.compression = self._scalar(259)
        self.predictor = self._scalar(317, 1)
        self.planar = self._scalar(284, 1)
        self.spp = self._scalar(277, 1)
        self.bps = self._array(258)[0]
        self.sample_format = self._array(339, [1])[0]
        if self.compression != 8:
            raise SystemExit(f"{url}: compression {self.compression}, only DEFLATE (8) handled")
        if self.bps != 32 or self.sample_format != 3:
            raise SystemExit(f"{url}: expected float32, got bps={self.bps} fmt={self.sample_format}")
        self.tiles_across = math.ceil(self.width / self.tw)
        self.tiles_down = math.ceil(self.length / self.tl)

        self.tile_offsets = self._array(324)
        self.tile_bytecounts = self._array(325)

        scale = self._doubles(33550)
        tie = self._doubles(33922)
        self.px, self.py = scale[0], scale[1]
        self.originx, self.originy = tie[3], tie[4]

    def _read_ifd(self, off: int) -> dict:
        n = struct.unpack("<H", self.hdr[off:off + 2])[0]
        out = {}
        for i in range(n):
            o = off + 2 + i * 12
            tag, typ = struct.unpack("<HH", self.hdr[o:o + 4])
            cnt = struct.unpack("<I", self.hdr[o + 4:o + 8])[0]
            size = TYPESZ.get(typ, 1) * cnt
            voff = o + 8 if size <= 4 else struct.unpack("<I", self.hdr[o + 8:o + 12])[0]
            out[tag] = (typ, cnt, voff, size)
        return out

    def _raw(self, tag: int) -> bytes | None:
        e = self.tags.get(tag)
        if not e:
            return None
        _typ, _cnt, voff, size = e
        if voff + size <= len(self.hdr):
            return self.hdr[voff:voff + size]
        return get(self.url, voff, voff + size - 1)          # value lives past the fetched header

    def _array(self, tag: int, default=None) -> list:
        e = self.tags.get(tag)
        if not e:
            if default is None:
                raise SystemExit(f"{self.url}: missing required tag {tag}")
            return default
        typ, cnt, _voff, _size = e
        raw = self._raw(tag)
        fmt = {3: "H", 4: "I", 1: "B"}.get(typ)
        if not fmt:
            raise SystemExit(f"{self.url}: tag {tag} unexpected type {typ}")
        return list(struct.unpack("<" + fmt * cnt, raw[:TYPESZ[typ] * cnt]))

    def _scalar(self, tag: int, default=None):
        e = self.tags.get(tag)
        if not e:
            if default is None:
                raise SystemExit(f"{self.url}: missing required tag {tag}")
            return default
        return self._array(tag)[0]

    def _doubles(self, tag: int) -> list:
        _typ, cnt, _voff, _size = self.tags[tag]
        raw = self._raw(tag)
        return list(struct.unpack("<" + "d" * cnt, raw[:8 * cnt]))

    def band_plane_base(self, band_index: int) -> int:
        """First tile index for a band. PlanarConfig=2 stores each band's tiles contiguously."""
        if self.planar != 2:
            return 0
        return band_index * self.tiles_across * self.tiles_down

    def _undo_fp_predictor(self, buf: bytearray, rows: int, row_bytes: int) -> bytes:
        """TIFF Predictor=3, per libtiff fpAcc: cumulative byte sum then a byte-plane de-shuffle.

        For PlanarConfig=Separate the horizontal stride is one byte, so accumulation is a plain
        cumulative sum over the row. The de-shuffle is endian-dependent; this is the little-endian
        form, which is what these files are.
        """
        bps = self.bps // 8
        samples = row_bytes // bps
        out = bytearray(len(buf))
        for r in range(rows):
            row = np.frombuffer(bytes(buf[r * row_bytes:(r + 1) * row_bytes]), dtype=np.uint8)
            acc = np.cumsum(row, dtype=np.uint64).astype(np.uint8)
            planes = acc.reshape(bps, samples)
            # little-endian: byte b of sample i comes from plane (bps-1-b)
            deshuffled = planes[::-1, :].T.reshape(-1)
            out[r * row_bytes:(r + 1) * row_bytes] = deshuffled.tobytes()
        return bytes(out)

    def read_tile(self, band_index: int, tx: int, ty: int) -> np.ndarray:
        idx = self.band_plane_base(band_index) + ty * self.tiles_across + tx
        off, cnt = self.tile_offsets[idx], self.tile_bytecounts[idx]
        if cnt == 0:
            return np.full((self.tl, self.tw), NODATA, dtype=np.float32)
        raw = zlib.decompress(get(self.url, off, off + cnt - 1))
        row_bytes = self.tw * (self.bps // 8)
        if self.predictor == 3:
            raw = self._undo_fp_predictor(bytearray(raw), self.tl, row_bytes)
        elif self.predictor != 1:
            raise SystemExit(f"{self.url}: predictor {self.predictor} not handled")
        a = np.frombuffer(raw, dtype="<f4", count=self.tw * self.tl)
        return a.reshape(self.tl, self.tw)

    def window(self, band_index: int, xmin, ymin, xmax, ymax, log=None):
        """Read the smallest tile-aligned window covering a UTM rectangle."""
        c0 = int((xmin - self.originx) / self.px)
        c1 = int(math.ceil((xmax - self.originx) / self.px))
        r0 = int((self.originy - ymax) / self.py)
        r1 = int(math.ceil((self.originy - ymin) / self.py))
        c0, r0 = max(c0, 0), max(r0, 0)
        c1, r1 = min(c1, self.width), min(r1, self.length)
        if c1 <= c0 or r1 <= r0:
            return None
        tx0, tx1 = c0 // self.tw, (c1 - 1) // self.tw
        ty0, ty1 = r0 // self.tl, (r1 - 1) // self.tl
        nt = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
        if log:
            log(f"    {nt} internal tiles ({tx1-tx0+1}x{ty1-ty0+1}) covering "
                f"cols {c0}-{c1} rows {r0}-{r1}")
        buf = np.full(((ty1 - ty0 + 1) * self.tl, (tx1 - tx0 + 1) * self.tw), NODATA,
                      dtype=np.float32)
        done = 0
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                buf[(ty - ty0) * self.tl:(ty - ty0 + 1) * self.tl,
                    (tx - tx0) * self.tw:(tx - tx0 + 1) * self.tw] = self.read_tile(band_index, tx, ty)
                done += 1
                if log and done % 32 == 0:
                    log(f"      {done}/{nt} tiles")
        # crop to the requested pixel window
        sub = buf[r0 - ty0 * self.tl: r1 - ty0 * self.tl,
                  c0 - tx0 * self.tw: c1 - tx0 * self.tw]
        return {
            "data": sub,
            "originx": self.originx + c0 * self.px,
            "originy": self.originy - r0 * self.py,
            "px": self.px, "py": self.py,
        }


# ---------------------------------------------------------------- manifest
def band_index(manifest: dict, name: str) -> int:
    for b in manifest["bands"]:
        if b["id"] == name:
            return b.get("tilesetBandIndex", 0)
    raise SystemExit(f"band {name!r} not in manifest; have "
                     f"{[b['id'] for b in manifest['bands']]}")


def tiles_for_box(manifest: dict, box) -> list[dict]:
    prefix = manifest["uriPrefix"].replace("gs://open-buildings-temporal-data/v1/geotiffs/", "")
    out = []
    for ts in manifest["tilesets"]:
        for s in ts["sources"]:
            a, dim = s["affineTransform"], s["dimensions"]
            x0, y0 = a["translateX"], a["translateY"]
            x1 = x0 + a["scaleX"] * dim["width"]
            y1 = y0 + a["scaleY"] * dim["height"]
            xmin, xmax = min(x0, x1), max(x0, x1)
            ymin, ymax = min(y0, y1), max(y0, y1)
            if xmax < box[0] or xmin > box[2] or ymax < box[1] or ymin > box[3]:
                continue
            out.append({"url": f"{GEOTIFFS}/{prefix}{s['uris'][0]}",
                        "bounds": [xmin, ymin, xmax, ymax]})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="config/study-area.json")
    ap.add_argument("--year", type=int, default=2023)
    ap.add_argument("--out", default="spike/_raw/heights")
    a = ap.parse_args()

    cfg = json.loads(pathlib.Path(a.config).read_text())
    # The locked local origin is the CENTRE of the bbox in UTM 43N, and runtime coordinates are
    # offsets from it. The runtime z axis points south (three.js convention), which is why the
    # northing bounds are built by SUBTRACTING the z extent rather than adding it — getting that
    # backwards would have read a window 4 km north of the city and returned a field of zeros.
    o = cfg["study_area"]["local_origin_utm"]
    cx, cz = o["easting"], o["northing"]
    w, h = cfg["study_area"]["measured_extent_m"]
    box = (cx - w / 2, cz - h / 2, cx + w / 2, cz + h / 2)
    print(f"  study box EPSG:32643  {[round(v) for v in box]}")

    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    # UTM zone 43N covers Delhi; the dataset splits manifests by S2 cell within each zone
    found = []
    for cell in ("39", "3b", "38", "3a"):
        url = f"{MANIFEST}/{cell}_EPSG_32643_{a.year}_06_30.json"
        try:
            man = json.loads(get(url, timeout=180))
        except urllib.error.HTTPError:
            continue
        hits = tiles_for_box(man, box)
        if hits:
            bi = band_index(man, BAND_NAME)
            print(f"  manifest {cell}: {len(hits)} source tile(s) overlap, "
                  f"{BAND_NAME} is band index {bi}")
            found.append((man, bi, hits))
    if not found:
        print("  no source tiles overlap the study box", file=sys.stderr)
        return 1

    pieces = []
    for man, bi, hits in found:
        for h in hits:
            print(f"  {h['url'].rsplit('/', 1)[-1]}")
            t = Tiff(h["url"])
            w = t.window(bi, *box, log=print)
            if w is None:
                print("    no overlap after pixel clipping")
                continue
            valid = w["data"] > 0
            print(f"    {w['data'].shape[1]}x{w['data'].shape[0]} px, "
                  f"{100 * valid.mean():.1f}% above zero, "
                  f"max {float(w['data'][valid].max()) if valid.any() else 0:.1f} m")
            pieces.append(w)

    if not pieces:
        print("  nothing read", file=sys.stderr)
        return 1

    # mosaic onto one grid at the source 0.5 m, taking the maximum where tiles overlap
    px = pieces[0]["px"]
    gx0 = min(p["originx"] for p in pieces)
    gy1 = max(p["originy"] for p in pieces)
    gx1 = max(p["originx"] + p["data"].shape[1] * p["px"] for p in pieces)
    gy0 = min(p["originy"] - p["data"].shape[0] * p["py"] for p in pieces)
    W = int(round((gx1 - gx0) / px))
    H = int(round((gy1 - gy0) / px))
    grid = np.full((H, W), np.nan, dtype=np.float32)
    for p in pieces:
        c = int(round((p["originx"] - gx0) / px))
        r = int(round((gy1 - p["originy"]) / px))
        d = p["data"].copy()
        d[d <= NODATA + 1] = np.nan
        sl = grid[r:r + d.shape[0], c:c + d.shape[1]]
        np.copyto(sl, np.fmax(sl, d), where=~np.isnan(d))

    npz = out / f"open-buildings-height-{a.year}.npz"
    np.savez_compressed(npz, height=grid,
                        transform=np.array([gx0, px, gy1, -px], dtype=np.float64))
    meta = {
        "dataset": "Google Research Open Buildings 2.5D Temporal v1",
        "band": BAND_NAME, "year": a.year,
        "licence": "CC-BY 4.0 and ODbL 1.0",
        "attribution": "Building heights © Google Research Open Buildings 2.5D Temporal, "
                       "derived from Copernicus Sentinel-2",
        "published_mae_m": 1.5,
        "source_resolution_m": px,
        "effective_resolution_m": 4.0,
        "crs": "EPSG:32643",
        "origin": [gx0, gy1], "pixel": [px, -px],
        "shape": [int(H), int(W)],
        "valid_px": int(np.isfinite(grid).sum()),
        "above_zero_px": int((grid > 0).sum()),
        "max_m": float(np.nanmax(grid)) if np.isfinite(grid).any() else None,
        "note": "Height above ground in metres, not elevation. Fetched by HTTP range request "
                "over the internally-tiled source GeoTIFFs; only the study box was downloaded.",
    }
    (out / f"open-buildings-height-{a.year}.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"\n  wrote {npz} ({npz.stat().st_size / 1e6:.1f} MB)  {W}x{H} px at {px} m")
    print(f"  above zero: {meta['above_zero_px']:,} px   max {meta['max_m']:.1f} m")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
