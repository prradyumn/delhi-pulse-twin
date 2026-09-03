"""Height rule v0.1 — load-bearing for ~92% of buildings in this box, so it is explicit,
versioned and reported. See config/study-area.json:height_rule."""
from __future__ import annotations


def resolve(tags: dict, area_m2: float, rule: dict) -> tuple[float, str, str]:
    """-> (height_m, mode, basis).  mode is 'observed' or 'estimated'."""
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

    cls = tags.get("building", "yes")
    levels = rule["class_levels"].get(cls, rule["class_levels"]["yes"])
    basis = f"rule:class={cls}"
    for ov in rule["area_overrides"]:
        if "if_area_lt_m2" in ov and area_m2 < ov["if_area_lt_m2"]:
            levels = ov["levels"]; basis = f"rule:area<{ov['if_area_lt_m2']}"
        if "if_area_gt_m2" in ov and area_m2 > ov["if_area_gt_m2"]:
            levels = min(levels, ov["max_levels"]); basis = f"rule:area>{ov['if_area_gt_m2']}"
    return round(levels * storey, 1), "estimated", basis
