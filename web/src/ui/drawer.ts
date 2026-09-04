import { el, clear, add } from "./dom";
import { modeLabel } from "../geo/load";
import type { Building, Road, Corridor, Stop, Station, Provenance, HeightRule } from "../geo/types";
import type { CorridorMetrics } from "../scenario/engine";
import { trafficLabel } from "../layers/palette";

export type Selection =
  | { kind: "building"; b: Building; prov: Provenance | null; rule: HeightRule }
  | { kind: "road"; r: Road; prov: Provenance | null }
  | { kind: "corridor"; c: Corridor; segIndex: number; metrics: CorridorMetrics; prov: Provenance | null }
  | { kind: "stop"; s: Stop; routes: string[]; prov: Provenance | null }
  | { kind: "station"; s: Station; prov: Provenance | null };

const n1 = (v: number) => v.toFixed(1);

/** Every analytical mark is inspectable, and the drawer always carries source, timestamp, unit and
 *  data mode. That is FR-10, and it is the reason a Provenance is a required field on every layer. */
export function drawer(onClose: () => void) {
  const body = el("div", { class: "pbody" });
  const title = el("h2", { text: "Selection" });
  const closeBtn = el("button", { class: "chip", text: "Close" });
  closeBtn.addEventListener("click", onClose);
  const node = el("aside", { class: "panel hidden", id: "drawer" },
    el("div", { class: "phead" }, title, closeBtn), body);

  /** `scope` names what the layer-level mode actually applies to. Without it a building reads
   *  "Height: estimated" directly above "Mode: Observed", which looks like a contradiction —
   *  the geometry is observed, the height is not, and the panel has to say which is which. */
  function provBlock(p: Provenance | null, scope?: string) {
    if (!p) return el("p", { class: "note", text: "No provenance record — this should not happen." });
    return el("div", {},
      el("h3", { class: "sub", text: "Provenance" }),
      el("div", { class: "kv" },
        el("dt", { text: scope ? `Mode — ${scope}` : "Mode" }),
        el("dd", {}, el("span", { class: `badge ${p.mode === "observed" ? "base" : p.mode === "estimated" ? "est" : "sim"}`,
                                  text: modeLabel(p.mode) })),
        el("dt", { text: "Provider" }), el("dd", { text: p.provider }),
        el("dt", { text: "Dataset" }), el("dd", { text: p.dataset }),
        el("dt", { text: "Licence" }), el("dd", { text: p.license }),
        el("dt", { text: "Retrieved" }), el("dd", { class: "num", text: p.retrieved_at }),
        el("dt", { text: "Source time" }), el("dd", { class: "num", text: p.source_time ?? "not applicable" }),
        el("dt", { text: "CRS" }), el("dd", { class: "num", text: p.crs }),
        el("dt", { text: "Transform" }), el("dd", { class: "num", text: `v${p.transform_version}` })),
      p.limitations.length
        ? el("div", {}, el("h3", { class: "sub", text: "Known limitations" }),
             el("ul", { class: "limits" }, ...p.limitations.map((l) => el("li", { text: l }))))
        : null);
  }

  function show(sel: Selection) {
    node.classList.remove("hidden");
    clear(body);

    if (sel.kind === "building") {
      const { b, rule } = sel;
      title.textContent = b.n ?? "Building";
      const estimated = b.m === 1;
      const remote = b.m === 2;
      add(body, 
        el("div", { class: "kv" },
          el("dt", { text: "Name" }), el("dd", { text: b.n ?? "unnamed" }),
          el("dt", { text: "Class" }), el("dd", { text: `building=${b.c}` }),
          el("dt", { text: "Height" }),
          el("dd", { class: "num" }, `${n1(b.h)} m `,
             el("span", { class: `badge ${estimated ? "est" : remote ? "sim" : "base"}`,
                          text: estimated ? "estimated" : remote ? "satellite" : "OSM tag" })),
          el("dt", { text: "Storeys" }), el("dd", { class: "num", text: `≈ ${(b.h / rule.storey_m).toFixed(1)} at ${rule.storey_m} m` }),
          el("dt", { text: "Footprint" }), el("dd", { class: "num", text: `${b.r.length} vertices` }),
          el("dt", { text: "OSM id" }), el("dd", { class: "num", text: b.id.replace("b/", "") })),
        estimated
          ? el("div", { class: "disabled-reason" },
              `This height was not measured. Rule v${rule.version} assigned `
              + `${rule.class_levels[b.c] ?? rule.class_levels["yes"]} storeys for building=${b.c}, `
              + `at ${rule.storey_m} m each — the satellite raster did not see a building here, `
              + `which happens on footprints smaller than its 4 m resolution and on anything built `
              + `after the 2023 imagery.`)
          : remote
          ? el("p", { class: "note", style: "margin-top:10px" },
              "Measured from satellite: the median of the building pixels inside this footprint in "
              + "Google Open Buildings 2.5D, published mean absolute error 1.5 m. Scored against "
              + "the buildings in this box that also carry an OSM height, it beats the class rule "
              + "it replaced by 36%. Above 45 m it under-reads by 12–18 m.")
          : el("p", { class: "note", style: "margin-top:10px",
                      text: "This height comes from an OSM height or building:levels tag — somebody "
                          + "recorded it on the ground. That outranks the satellite, because the "
                          + "two describe different years." }),
        provBlock(sel.prov, "footprint geometry"));
      return;
    }

    if (sel.kind === "road") {
      const { r } = sel;
      title.textContent = r.n ?? `${r.k} road`;
      add(body, 
        el("div", { class: "kv" },
          el("dt", { text: "Name" }), el("dd", { text: r.n ?? "unnamed" }),
          el("dt", { text: "Class" }), el("dd", { text: `highway=${r.k}` }),
          el("dt", { text: "Length" }), el("dd", { class: "num", text: `${n1(r.len)} m` }),
          el("dt", { text: "Lanes" }), el("dd", { class: "num", text: r.lanes ? String(r.lanes) : "not tagged" }),
          el("dt", { text: "One-way" }), el("dd", { text: r.oneway ? "yes" : "no" }),
          el("dt", { text: "Hero corridor" }), el("dd", { text: r.corridor ?? "no" }),
          el("dt", { text: "OSM id" }), el("dd", { class: "num", text: r.id.replace("r/", "") })),
        el("p", { class: "note", style: "margin-top:10px",
          text: "Geometry only. This layer carries no speed or volume measurement — corridor traffic is a separate, explicitly estimated layer." }),
        provBlock(sel.prov, "centreline geometry"));
      return;
    }

    if (sel.kind === "corridor") {
      const { c, segIndex, metrics } = sel;
      const seg = metrics.segments[segIndex];
      title.textContent = c.label;
      add(body, 
        el("p", { class: "note" },
          el("span", { class: "badge est", text: "estimated" }), " ",
          `Segment ${segIndex + 1} of ${c.segments.length}, ${n1(c.segments[segIndex].len)} m.`),
        el("div", { class: "metric" },
          el("span", { class: "m-l", text: "Segment state" }),
          el("span", { class: "m-v", text: trafficLabel(seg.ratio) })),
        el("div", { class: "metric" },
          el("span", { class: "m-l", text: "Estimated speed" }),
          el("span", { class: "m-v", text: `${n1(seg.speedKmh)} km/h` })),
        el("div", { class: "metric" },
          el("span", { class: "m-l", text: `Free flow (${c.role === "orientation-spine" ? "primary" : "secondary"})` }),
          el("span", { class: "m-v", text: `${n1(metrics.freeFlowKmh)} km/h` })),

        el("h3", { class: "sub", text: "Whole corridor" }),
        el("div", { class: "kv" },
          el("dt", { text: "Role" }), el("dd", { text: c.role }),
          el("dt", { text: "Spine" }), el("dd", { class: "num", text: `${n1(c.spine_len)} m from ${c.ways} OSM ways` }),
          el("dt", { text: "Chains" }), el("dd", { class: "num", text: `${c.chains} (longest used as spine)` }),
          el("dt", { text: "Mean speed" }), el("dd", { class: "num", text: `${n1(metrics.meanSpeedKmh)} km/h` }),
          el("dt", { text: "Travel time" }), el("dd", { class: "num", text: `${n1(metrics.travelTimeMin)} min` }),
          el("dt", { text: "Stress index" }), el("dd", { class: "num", text: metrics.msi.toFixed(2) }),
          el("dt", { text: "Bus routes" }),
          el("dd", { text: metrics.routesServing.length ? metrics.routesServing.join(", ") : "none" })),

        c.no_transit_reason
          ? el("div", { class: "disabled-reason" }, el("strong", { text: "No transit on this corridor. " }), c.no_transit_reason)
          : null,
        metrics.msiWeightsRenormalised
          ? el("p", { class: "note", style: "margin-top:8px",
              text: "With no transit term available, its weight is redistributed across speed and weather rather than counted as zero." })
          : null,
        provBlock(sel.prov, "spine geometry"));
      return;
    }

    if (sel.kind === "stop") {
      const { s } = sel;
      title.textContent = s.n;
      add(body, 
        el("div", { class: "kv" },
          el("dt", { text: "Name" }), el("dd", { text: s.n }),
          el("dt", { text: "Routes here" }), el("dd", { text: sel.routes.length ? sel.routes.join(", ") : "none in the selected set" }),
          el("dt", { text: "OSM id" }), el("dd", { class: "num", text: s.osm })),
        el("p", { class: "note", style: "margin-top:10px",
          text: "Stop position is observed OSM data. Arrival times are not available: the source carries no schedule, so no departure board can be shown honestly." }),
        provBlock(sel.prov, "stop position"));
      return;
    }

    const { s } = sel;
    title.textContent = s.n;
    add(body, 
      el("div", { class: "kv" },
        el("dt", { text: "Station" }), el("dd", { text: s.n }),
        el("dt", { text: "Type" }), el("dd", { text: s.sub ? "Metro (subway)" : "Rail" }),
        el("dt", { text: "OSM id" }), el("dd", { class: "num", text: s.id.replace("s/", "") })),
      el("p", { class: "note", style: "margin-top:10px",
        text: "Geographic context only. No live train service data is used anywhere in this product." }),
      provBlock(sel.prov, "station position"));
  }

  function hide() { node.classList.add("hidden"); }

  return { node, show, hide };
}
