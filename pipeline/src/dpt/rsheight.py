"""Per-footprint building heights from the satellite height raster.

Shared by `validate_heights.py`, which scores this against known OSM heights, and by the build,
which uses it. One implementation deliberately: a validator that measures something subtly
different from what the build applies is worse than no validator.

**Why the median of positive pixels.** Measured against the 241 buildings in this box carrying a
real OSM height tag, five candidate statistics were scored and stratified by height band. The
median of pixels above 1 m has the flattest bias across the bulk of the distribution — within
about 3 m from 0 to 45 m, where 213 of those 241 buildings sit — while the class rule it replaces
is biased -18.7 m at 25-45 m and -46.3 m above 45 m. For a 3D city, systematic bias is what
distorts a skyline and misplaces every shadow; scatter averages out over 3,000 buildings. So the
estimator was chosen for low bias, not for the lowest mean absolute error.

Known limitation, measured rather than assumed: above 45 m this under-reads by about 12-18 m. The
source is derived from Sentinel-2 and saturates on towers. No correction is applied, because the
sample that shows the bias is 29 buildings and fitting a correction to it would be inventing
precision.
"""
from __future__ import annotations
import json, pathlib

import numpy as np

DEFAULT_RASTER = pathlib.Path("spike/_raw/heights/open-buildings-height-2023.npz")
DEFAULT_META = pathlib.Path("spike/_raw/heights/open-buildings-height-2023.json")
#: pixels below this are ground, not building
FLOOR_M = 1.0
#: a footprint needs at least this many building pixels to be measured rather than guessed
MIN_PIXELS = 8
#: nothing renders below this; the statistic can return 1.5 m for a shed
MIN_HEIGHT_M = 2.5

# ---- the confidence gate, and the render that forced it.
#
# Four footprints tagged `apartments` at exactly 91.0 m (26 levels x 3.5 m), clustered within
# 200 m of each other, came back from the raster as ZERO — bare ground, no building pixels at all.
# Their OSM way ids are all around 1.4-1.5 billion, so they were mapped recently: these are towers
# built or still under construction after the 2023 imagery. The satellite is not wrong and OSM is
# not wrong; they describe different years.
#
# Without a gate, the nearest thing to a reading (a 1.5 m median over 15% of the footprint) would
# have been clamped to 2.5 m and shipped as the height of a 26-storey block. So a satellite height
# is only accepted when the raster actually sees a building there: enough pixels, covering enough
# of the footprint, at a plausible height. Otherwise the class rule is used and the reason is
# recorded, which also makes the disagreement itself countable.
#: building pixels must cover at least this share of the footprint
MIN_COVER = 0.35
#: below this the raster is reporting ground clutter, not a building
MIN_CREDIBLE_M = 3.0


class HeightRaster:
    def __init__(self, npz: pathlib.Path = DEFAULT_RASTER, meta: pathlib.Path = DEFAULT_META):
        z = np.load(npz)
        self.h = z["height"]
        gx0, px, gy1, py = (float(v) for v in z["transform"])
        self.gx0, self.px, self.gy1, self.py = gx0, px, gy1, py
        self.H, self.W = self.h.shape
        self.meta = json.loads(meta.read_text()) if meta.exists() else {}

    @classmethod
    def load_if_present(cls, npz: pathlib.Path = DEFAULT_RASTER,
                        meta: pathlib.Path = DEFAULT_META):
        """None when the raster has not been fetched, so the build degrades to the class rule
        rather than failing — same principle as every layer in the runtime."""
        if not npz.exists():
            return None
        return cls(npz, meta)

    def stats(self, ring, origin) -> tuple[float | None, int, float]:
        """(median height of building pixels, pixel count, building share of the footprint).

        Ring coordinates are runtime local metres with z pointing SOUTH (three.js), so northing is
        origin_northing - z. Reversing that sign samples a mirror image of the city, which
        correlates with nothing and looks exactly like the dataset being useless.
        """
        ox, oz = origin
        xs = np.asarray([p[0] for p in ring], dtype=np.float64) + ox
        ys = oz - np.asarray([p[1] for p in ring], dtype=np.float64)

        c0 = int(np.floor((xs.min() - self.gx0) / self.px))
        c1 = int(np.ceil((xs.max() - self.gx0) / self.px))
        r0 = int(np.floor((self.gy1 - ys.max()) / -self.py))
        r1 = int(np.ceil((self.gy1 - ys.min()) / -self.py))
        c0, r0 = max(c0, 0), max(r0, 0)
        c1, r1 = min(c1, self.W), min(r1, self.H)
        if c1 <= c0 or r1 <= r0:
            return None, 0, 0.0

        cc = np.arange(c0, c1)
        rr = np.arange(r0, r1)
        gx, gy = np.meshgrid(self.gx0 + (cc + 0.5) * self.px,
                             self.gy1 - (rr + 0.5) * (-self.py))
        inside = np.zeros(gx.shape, dtype=bool)
        n = len(xs)
        for i in range(n):
            x1, y1 = xs[i], ys[i]
            x2, y2 = xs[(i + 1) % n], ys[(i + 1) % n]
            if y1 == y2:
                continue
            band = (gy >= min(y1, y2)) & (gy < max(y1, y2))
            with np.errstate(invalid="ignore", divide="ignore"):
                xint = x1 + (gy - y1) * (x2 - x1) / (y2 - y1)
            inside ^= band & (gx < xint)
        if not inside.any():
            return None, 0, 0.0

        vals = self.h[r0:r1, c0:c1][inside]
        vals = vals[np.isfinite(vals)]
        if vals.size == 0:
            return None, 0, 0.0
        pos = vals[vals > FLOOR_M]
        if pos.size < MIN_PIXELS:
            return None, int(pos.size), float(pos.size / vals.size)
        return float(np.median(pos)), int(pos.size), float(pos.size / vals.size)

    def height_for(self, ring, origin) -> tuple[float | None, int, str]:
        """(height or None, pixel count, reason). The reason is kept so the build can report why
        a footprint fell back to the rule rather than silently doing so."""
        med, px, cover = self.stats(ring, origin)
        if med is None:
            return None, px, "too_few_pixels" if px < MIN_PIXELS else "outside_raster"
        if cover < MIN_COVER:
            return None, px, "low_coverage"
        if med < MIN_CREDIBLE_M:
            return None, px, "below_credible_height"
        return max(round(med, 1), MIN_HEIGHT_M), px, "ok"
