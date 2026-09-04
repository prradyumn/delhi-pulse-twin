"""Height rule v0.2 — explicit, versioned and reported, because it decides every skyline and every
shadow in the render. See config/study-area.json:height_rule.

v0.1 was a class-based guess and it carried 91.8% of the buildings in this box. Scoring it against
the 241 footprints that hold a real OSM height tag showed the error is not uniform: most classes
land within a storey, and it is biased **-18.7 m at 25-45 m and -45.2 m above 45 m**. It flattened
tall Delhi. Per class the worst case was `apartments` at +38.5 m out — the rule assumed a
four-storey walk-up where central Delhi has high-rise blocks.

v0.2 inserts a measured source above the rule: satellite building heights from Google Research Open
Buildings 2.5D Temporal (see dpt.rsheight). On the same 234 buildings it scores MAE 6.47 m against
the rule's 10.16 m, with bias -2.6 m against -7.3 m.

The order is now: OSM height tag, OSM levels, satellite, class rule. OSM stays on top even though
the satellite is more consistent, because the two describe different years — four towers tagged at
91 m sit on ground the 2023 imagery sees as empty, and a contributor standing in front of a
finished building beats a satellite that flew before it was built.
"""
from __future__ import annotations


def resolve(tags: dict, area_m2: float, rule: dict,
            rs_height: float | None = None) -> tuple[float, str, str]:
    """-> (height_m, mode, basis).

    mode is 'observed' (an OSM tag), 'remote_sensed' (the satellite raster) or 'estimated' (the
    class rule). Three modes rather than two, because collapsing a 1.5 m-MAE measurement into the
    same bucket as an authored guess would throw away the entire point of measuring it.

    `rs_height` is passed in already gated by dpt.rsheight — None means the raster did not see a
    building there, not that it saw a short one.
    """
    storey = rule["storey_m"]

    h = tags.get("height")
    if h:
        try:
            v = float(str(h).replace("m", "").strip().split()[0])
            if 1.5 <= v <= 300:
                return round(v, 1), "observed", "osm:height"
        except (ValueError, IndexError):
            pass

    lv = tags.get("building:levels")
    if lv:
        try:
            n = float(str(lv).split(";")[0].strip())
            if 0.5 <= n <= 60:
                return round(n * storey, 1), "observed", "osm:building:levels"
        except ValueError:
            pass

    # Measured, and above the rule: 36% lower MAE and less than half the bias on the buildings
    # where both can be checked. In the 8-25 m band the class rule actually has slightly lower
    # scatter (MAE 3.3 vs 4.1 m) and the satellite is still preferred, because its bias is smaller
    # in every band and the rule's is structural — a skyline flattened by 45 m is not fixed by
    # tidier mid-rise scatter.
    if rs_height is not None:
        return round(float(rs_height), 1), "remote_sensed", "open-buildings-2.5d:median"

    cls = tags.get("building", "yes")
    levels = rule["class_levels"].get(cls, rule["class_levels"]["yes"])
    basis = f"rule:class={cls}"
    for ov in rule["area_overrides"]:
        if "if_area_lt_m2" in ov and area_m2 < ov["if_area_lt_m2"]:
            levels = ov["levels"]; basis = f"rule:area<{ov['if_area_lt_m2']}"
        if "if_area_gt_m2" in ov and area_m2 > ov["if_area_gt_m2"]:
            levels = min(levels, ov["max_levels"]); basis = f"rule:area>{ov['if_area_gt_m2']}"
    return round(levels * storey, 1), "estimated", basis
