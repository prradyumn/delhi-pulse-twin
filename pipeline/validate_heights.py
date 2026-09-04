#!/usr/bin/env python3
"""Score satellite building heights against the OSM heights we actually know.

The rule this replaces is 91.8% of the skyline, so the satellite raster does not get adopted on
the strength of a published accuracy figure. It gets scored here, on the 261 buildings in this box
that carry a real OSM `height` or `building:levels` tag, and it gets adopted only for the cases
where it wins.

Two things this is careful about.

**Which statistic.** A footprint covers many raster pixels and the edge ones blend with the ground
at 4 m effective resolution, so "the height of this building" is a choice: median, p75, p90, max,
or mean of the positive pixels. That choice is not argued, it is measured — every candidate is
scored and the table is printed.

**The OSM sample is biased.** Contributors tag tall and notable buildings first: this sample's p90
is 45.5 m, which is not central Delhi. So errors are reported stratified by height band, because a
statistic that wins overall could be winning only on towers and failing on the two-storey stock
that makes up most of the box.
"""
from __future__ import annotations
import argparse, collections, json, pathlib, statistics, sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "src"))


def load_raster(npz: pathlib.Path):
    z = np.load(npz)
    h = z["height"]
    gx0, px, gy1, py = z["transform"]
    return h, float(gx0), float(px), float(gy1), float(py)


def footprint_pixels(ring, gx0, px, gy1, py, H, W, origin):
    """Pixel indices whose centres fall inside a footprint ring, by vectorised even-odd test.

    Ring coordinates are runtime local metres (x east, z SOUTH — three.js convention), so the
    northing is origin_northing - z. Getting that sign wrong samples a mirror image of the city,
    which correlates with nothing and would look like the dataset being useless.
    """
    ox, oz = origin
    xs = np.array([p[0] for p in ring], dtype=np.float64) + ox
    ys = oz - np.array([p[1] for p in ring], dtype=np.float64)

    c0 = int(np.floor((xs.min() - gx0) / px)); c1 = int(np.ceil((xs.max() - gx0) / px))
    r0 = int(np.floor((gy1 - ys.max()) / -py)); r1 = int(np.ceil((gy1 - ys.min()) / -py))
    c0, r0 = max(c0, 0), max(r0, 0)
    c1, r1 = min(c1, W), min(r1, H)
    if c1 <= c0 or r1 <= r0:
        return None, None

    cc = np.arange(c0, c1); rr = np.arange(r0, r1)
    PX = gx0 + (cc + 0.5) * px
    PY = gy1 - (rr + 0.5) * (-py)
    gxv, gyv = np.meshgrid(PX, PY)

    inside = np.zeros(gxv.shape, dtype=bool)
    n = len(xs)
    for i in range(n):
        x1, y1 = xs[i], ys[i]
        x2, y2 = xs[(i + 1) % n], ys[(i + 1) % n]
        if y1 == y2:
            continue
        cond = ((gyv >= np.minimum(y1, y2)) & (gyv < np.maximum(y1, y2)))
        with np.errstate(invalid="ignore", divide="ignore"):
            xint = x1 + (gyv - y1) * (x2 - x1) / (y2 - y1)
        inside ^= cond & (gxv < xint)
    return inside, (r0, r1, c0, c1)


CANDIDATES = {
    "median>1": lambda v: float(np.median(v)) if v.size else None,
    "p75>1":    lambda v: float(np.percentile(v, 75)) if v.size else None,
    "p90>1":    lambda v: float(np.percentile(v, 90)) if v.size else None,
    "max":      lambda v: float(v.max()) if v.size else None,
    "mean>1":   lambda v: float(v.mean()) if v.size else None,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config/study-area.json")
    ap.add_argument("--buildings", default="web/public/data/@v1/buildings.json")
    ap.add_argument("--raster", default="spike/_raw/heights/open-buildings-height-2023.npz")
    ap.add_argument("--min-px", type=int, default=8,
                    help="footprints with fewer positive pixels than this are not scored")
    ap.add_argument("--out", default="snapshots/v1/height-validation.json")
    a = ap.parse_args()

    cfg = json.loads(pathlib.Path(a.config).read_text())
    o = cfg["study_area"]["local_origin_utm"]
    origin = (o["easting"], o["northing"])
    bl = json.loads(pathlib.Path(a.buildings).read_text())["features"]
    h, gx0, px, gy1, py = load_raster(pathlib.Path(a.raster))
    H, W = h.shape
    print(f"  raster {W}x{H} at {px} m, origin {gx0:.0f},{gy1:.0f}")
    print(f"  buildings {len(bl)}")

    rows = []
    no_px = 0
    for b in bl:
        mask, win = footprint_pixels(b["r"], gx0, px, gy1, py, H, W, origin)
        if mask is None or not mask.any():
            no_px += 1
            continue
        r0, r1, c0, c1 = win
        sub = h[r0:r1, c0:c1]
        vals = sub[mask]
        vals = vals[np.isfinite(vals)]
        pos = vals[vals > 1.0]
        if pos.size < a.min_px:
            no_px += 1
            continue
        rec = {"id": b["id"], "cls": b["c"], "observed": b["m"] == 0, "osm_h": b["h"],
               "px": int(pos.size), "cover": float(pos.size / max(vals.size, 1))}
        for name, fn in CANDIDATES.items():
            rec[name] = fn(pos)
        rows.append(rec)

    print(f"  scored {len(rows)} footprints, {no_px} skipped for too few positive pixels")
    known = [r for r in rows if r["observed"]]
    print(f"  of which {len(known)} carry a real OSM height\n")

    # ---- which statistic recovers the known heights best
    print("  statistic          n     MAE      bias   median|err|   within 3m   within 6m")
    best = None
    table = {}
    for name in CANDIDATES:
        errs = [r[name] - r["osm_h"] for r in known if r[name] is not None]
        if not errs:
            continue
        mae = statistics.fmean(abs(e) for e in errs)
        bias = statistics.fmean(errs)
        med = statistics.median(sorted(abs(e) for e in errs))
        w3 = 100 * sum(1 for e in errs if abs(e) <= 3) / len(errs)
        w6 = 100 * sum(1 for e in errs if abs(e) <= 6) / len(errs)
        table[name] = {"n": len(errs), "mae_m": round(mae, 2), "bias_m": round(bias, 2),
                       "median_abs_err_m": round(med, 2),
                       "within_3m_pct": round(w3, 1), "within_6m_pct": round(w6, 1)}
        print(f"  {name:14} {len(errs):>5}  {mae:>6.2f}  {bias:>+7.2f}  {med:>10.2f}"
              f"  {w3:>9.1f}%  {w6:>9.1f}%")
        if best is None or mae < table[best]["mae_m"]:
            best = name
    print(f"\n  best by MAE: {best}")

    # ---- the rule, scored on exactly the same buildings, for a fair comparison
    rule = cfg["height_rule"]
    cl, st = rule["class_levels"], rule["storey_m"]
    rule_errs, rs_errs = [], []
    for r in known:
        guess = cl.get(r["cls"], cl["yes"]) * st
        rule_errs.append(guess - r["osm_h"])
        rs_errs.append(r[best] - r["osm_h"])
    rule_mae = statistics.fmean(abs(e) for e in rule_errs)
    rs_mae = statistics.fmean(abs(e) for e in rs_errs)
    print(f"\n  on the SAME {len(known)} buildings:")
    print(f"    class rule v{rule['version']}   MAE {rule_mae:6.2f} m   "
          f"bias {statistics.fmean(rule_errs):+6.2f} m")
    print(f"    satellite ({best})  MAE {rs_mae:6.2f} m   "
          f"bias {statistics.fmean(rs_errs):+6.2f} m")
    print(f"    improvement: {100 * (rule_mae - rs_mae) / rule_mae:+.1f}% MAE")

    # ---- stratified, for EVERY candidate, because the overall MAE is dominated by the tall
    # buildings the OSM sample over-represents. A statistic can win overall while losing on the
    # two-storey stock that is most of the box, and picking on the overall figure alone would
    # have adopted exactly that.
    print("\n  stratified by observed height — MAE per band (the OSM sample is biased tall):")
    bands = [(0, 8), (8, 15), (15, 25), (25, 45), (45, 200)]
    hdr = f"    {'band':>10} {'n':>4} {'rule':>7}" + "".join(f"{k:>10}" for k in CANDIDATES)
    print(hdr)
    strat = {}
    for lo, hi in bands:
        grp = [r for r in known if lo <= r["osm_h"] < hi]
        if not grp:
            continue
        rm = statistics.fmean(abs(cl.get(r["cls"], cl["yes"]) * st - r["osm_h"]) for r in grp)
        cells, entry = [], {"n": len(grp), "rule_mae_m": round(rm, 2)}
        for k in CANDIDATES:
            m = statistics.fmean(abs(r[k] - r["osm_h"]) for r in grp)
            b = statistics.fmean(r[k] - r["osm_h"] for r in grp)
            entry[k] = {"mae_m": round(m, 2), "bias_m": round(b, 2)}
            cells.append(f"{m:>10.2f}")
        strat[f"{lo}-{hi}"] = entry
        print(f"    {lo:>4}-{hi:<4} {len(grp):>4} {rm:>7.2f}" + "".join(cells))
    print("\n  and the BIAS per band, which matters more than scatter for a skyline:")
    print(hdr)
    for lo, hi in bands:
        key = f"{lo}-{hi}"
        if key not in strat:
            continue
        e = strat[key]
        rb = statistics.fmean(cl.get(r["cls"], cl["yes"]) * st - r["osm_h"]
                              for r in known if lo <= r["osm_h"] < hi)
        print(f"    {lo:>4}-{hi:<4} {e['n']:>4} {rb:>+7.2f}"
              + "".join(f"{e[k]['bias_m']:>+10.2f}" for k in CANDIDATES))

    # ---- what it would change across the whole box
    est = [r for r in rows if not r["observed"] and r[best] is not None]
    deltas = [r[best] - (cl.get(r["cls"], cl["yes"]) * st) for r in est]
    print(f"\n  across the {len(est)} rule-estimated buildings the satellite has a height for:")
    if deltas:
        ds = sorted(deltas)
        qq = lambda p: ds[min(len(ds) - 1, int(p * len(ds)))]
        print(f"    change p10 {qq(.10):+.1f} m   median {qq(.50):+.1f} m   p90 {qq(.90):+.1f} m")
        print(f"    would be raised on {100 * sum(1 for d in deltas if d > 1) / len(deltas):.0f}% "
              f"and lowered on {100 * sum(1 for d in deltas if d < -1) / len(deltas):.0f}%")
    worst = sorted(((abs(d), r) for d, r in zip(deltas, est)), key=lambda t: -t[0])[:6]
    print("    biggest disagreements with the rule:")
    for _m, r in worst:
        print(f"      {r['cls']:12} rule {cl.get(r['cls'], cl['yes']) * st:>5.1f} m  "
              f"satellite {r[best]:>5.1f} m  ({r['px']:,} px)")

    outp = pathlib.Path(a.out)
    outp.parent.mkdir(parents=True, exist_ok=True)
    outp.write_text(json.dumps({
        "scored_footprints": len(rows), "with_osm_height": len(known),
        "skipped_too_few_pixels": no_px,
        "statistic_comparison": table, "chosen_statistic": best,
        "rule_mae_m": round(rule_mae, 2), "satellite_mae_m": round(rs_mae, 2),
        "stratified": strat,
        "_note": "MAE against OSM height/building:levels tags in this box. That sample is "
                 "selection-biased towards tall and notable buildings, so the stratified table "
                 "is the honest read, not the overall figure.",
    }, indent=2) + "\n")
    print(f"\n  wrote {outp}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
