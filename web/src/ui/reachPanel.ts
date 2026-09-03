import { el, clear } from "./dom";
import { BANDS, BAND_COLOURS, BASE_OPACITY } from "../layers/reach";
import type { ReachMode, ReachResult, RoutePair } from "../analysis/reach";
import { ROUTE_COLOUR } from "../layers/routes";
import type { Graph } from "../analysis/network";

const n1 = (v: number) => v.toFixed(1);
const n2 = (v: number) => v.toFixed(2);

const MODES: { id: ReachMode; label: string; blurb: string }[] = [
  { id: "walk", label: "Walk from a point",
    blurb: "Everything you can reach on foot from one spot, in bands of five minutes." },
  { id: "stepfree", label: "Step-free penalty",
    blurb: "The same journey with stepped ways removed — a pram, a wheelchair, a suitcase. Red is what becomes unreachable." },
  { id: "metro", label: "Walk to the metro",
    blurb: "How far the nearest metro station is from wherever you are standing." },
  { id: "busstop", label: "Walk to a bus stop",
    blurb: "How far the nearest mapped bus stop is." },
  { id: "route", label: "Can a cleaner route help?",
    blurb: "Click a start, then a destination. The quickest walk and the lowest-dose walk are computed on the same network — and the answer is usually that they are the same walk." },
];

/**
 * The reach panel.
 *
 * The point of this panel is a comparison, not a number. "You are 800 m from the metro" is not
 * useful; "the walk is 1.6 km because the only crossing is 600 m the wrong way" is. So every mode
 * leads with the thing that is surprising about it, and the assumptions sit underneath where they
 * can be read but do not crowd out the finding.
 */
export function reachPanel(
  onMode: (m: ReachMode) => void,
  onClear: () => void,
  onOpacity: (v: number) => void,
) {
  let pair: RoutePair | null = null;
  let routeError: string | null = null;
  let waitingFor: "start" | "destination" | null = null;
  /** held in panel state: render() rebuilds the slider, and a fresh element would otherwise snap
   *  back to the default while the shader kept the value the user had chosen */
  let opacity = Math.round(BASE_OPACITY * 100);
  const body = el("div", { class: "pbody" });
  const badge = el("span", { class: "badge est", text: "estimated" });
  const node = el("aside", { class: "panel hidden", id: "reach" },
    el("div", { class: "phead" }, el("h2", { text: "Reach" }), badge), body);
  const closeBtn = el("button", { class: "chip", text: "Close" });
  (node.querySelector(".phead") as HTMLElement).append(closeBtn);
  closeBtn.addEventListener("click", () => hide());

  let mode: ReachMode = "walk";
  let result: ReachResult | null = null;
  let error: string | null = null;
  let graph: Graph | null = null;
  let busy = false;

  function legend() {
    if (mode === "stepfree") {
      const stops: [string, string][] = [
        ["#d1dbd4", "no penalty"], ["#f2dd9e", "up to 2 min"], ["#e5a85c", "2–5 min"],
        ["#c9663f", "5–10 min"], ["#9e2933", "10 min+ or cut off"],
      ];
      return el("div", { class: "rlegend" },
        ...stops.map(([c, t]) => el("span", { class: "rl" },
          el("i", { style: `background:${c}` }), t)));
    }
    return el("div", { class: "rlegend" },
      ...BANDS.map((b, i) => el("span", { class: "rl" },
        el("i", { style: `background:${BAND_COLOURS[i]}` }), `${b} min`)));
  }

  function modePicker() {
    const wrap = el("div", { class: "field" }, el("label", { text: "Question" }));
    const row = el("div", { class: "row", style: "flex-wrap:wrap;gap:4px" });
    for (const m of MODES) {
      const b = el("button", {
        class: mode === m.id ? "btn on" : "btn",
        style: "font-size:11px;padding:5px 8px", text: m.label,
      });
      b.addEventListener("click", () => { mode = m.id; onMode(m.id); render(); });
      row.append(b);
    }
    wrap.append(row);
    wrap.append(el("p", { class: "dnote", style: "margin-top:5px",
      text: MODES.find((m) => m.id === mode)?.blurb ?? "" }));
    return wrap;
  }

  function bandTable(r: ReachResult) {
    const kv = el("div", { class: "kv" });
    const served = r.servedKm2 || 1;
    BANDS.forEach((b, i) => {
      const km2 = r.areasKm2[i];
      kv.append(
        el("dt", {}, el("i", { class: "swatch", style: `background:${BAND_COLOURS[i]}` }),
                     ` within ${b} min`),
        el("dd", { class: "num", text: `${n2(km2)} km²  ·  ${((km2 / served) * 100).toFixed(0)}%` }));
    });
    return kv;
  }

  function render() {
    clear(body);
    body.append(modePicker());

    if (mode === "route") { renderRoute(); return; }
    if (busy) {
      body.append(el("p", { class: "note", text: "Computing…" }));
      return;
    }
    if (error) {
      body.append(el("div", { class: "disabled-reason", text: error }));
      body.append(assumptions());
      return;
    }
    if (!result) {
      body.append(el("div", { class: "insight" },
        el("strong", { text: "Click anywhere on the map " }),
        "to drop a starting point. The overlay then shows how far you can actually walk from it — along mapped streets and footways, not as the crow flies."));
      body.append(assumptions());
      return;
    }

    const r = result;

    if (r.fragment) {
      body.append(el("div", { class: "disabled-reason" },
        el("strong", { text: "This starting point is on an isolated piece of the map. " }),
        `The mapped ways around it form a fragment of ${r.fragment.nodes} nodes, cut off from the `
        + `main network of ${r.fragment.ofLargest.toLocaleString()}. Everything below is therefore a `
        + `property of the OSM data here, not of the city — on the ground you could almost `
        + `certainly walk out. Move the starting point nearer a mapped street.`));
    }
    body.append(legend());

    if (r.mode === "walk" || r.mode === "stepfree") {
      const i15 = BANDS.indexOf(15);
      body.append(el("h3", { class: "sub", text: "Area within reach" }), bandTable(r));

      // the finding: straight-line distance lies here, and by how much
      if (r.detour.worst) {
        const w = r.detour.worst;
        body.append(el("div", { class: "insight" },
          el("strong", { text: `A straight line under-states this walk by ${((r.detour.median - 1) * 100).toFixed(0)}%. ` }),
          `Half of everything you can reach costs at least `,
          el("b", { text: `${n2(r.detour.median)}×` }),
          ` its straight-line distance, and a tenth of it costs ${n2(r.detour.p90)}× or more. `,
          `The worst case from here is ${Math.round(w.lineM)} m away in a straight line and `,
          el("b", { text: `${Math.round(w.walkM)} m on foot` }),
          ` — ${n2(w.ratio)}× — because of what stands in between.`));
      }

      if (r.mode === "stepfree" && r.stepLossPct !== null && r.compareAreasKm2) {
        const lost = r.areasKm2[i15] - r.compareAreasKm2[i15];
        body.append(el("h3", { class: "sub", text: "What the steps cost" }));
        if (r.stepLossPct < 0.05) {
          // A zero here is a real result, not a broken feature, and saying so is more useful than
          // hunting for a number to report. Measured across ten origins in this box the penalty
          // ranged 0–2.6%, so zero is the common case and the honest headline.
          body.append(el("p", { class: "note" },
            el("strong", { text: "No steps on any shortest route from here. " }),
            "Every place reachable in 15 minutes is reachable step-free in the same time. The 110 "
            + "stepped ways mapped in this box are almost never the only link between two points — "
            + "which is worth knowing, and is not what you would guess from a map that draws them "
            + "the same as everything else."));
        } else {
          body.append(el("div", { class: r.stepLossPct > 2 ? "insight" : "note" },
            el("strong", { text: `${r.stepLossPct.toFixed(1)}% of the 15-minute area needs steps. ` }),
            `${n2(lost)} km² of what a walker can reach from here is not reachable step-free within `
            + `the same quarter of an hour. Those ways are tagged highway=steps in OSM — surveyed `
            + `infrastructure, not a guess — and in this box they are mostly foot overbridges, `
            + `which on a road like this are the only crossing there is.`));
        }
      }

      body.append(el("h3", { class: "sub", text: "Reached in 15 minutes" }),
        el("div", { class: "kv" },
          el("dt", { text: "Mapped places" }),
          el("dd", { class: "num", text: `${r.reached.places} of ${r.reached.placesTotal}` }),
          el("dt", { text: "Markets" }), el("dd", { class: "num", text: String(r.reached.markets) }),
          el("dt", { text: "Places of worship" }), el("dd", { class: "num", text: String(r.reached.worship) }),
          el("dt", { text: "Metro stations" }),
          el("dd", { class: "num", text: `${r.reached.metro} of ${r.reached.metroTotal}` }),
          el("dt", { text: "Bus stops" }),
          el("dd", { class: "num", text: `${r.reached.busStops} of ${r.reached.busStopsTotal}` })));

      const clr = el("button", { class: "btn", style: "margin-top:9px", text: "Clear starting point" });
      clr.addEventListener("click", () => { result = null; onClear(); render(); });
      body.append(clr);
    } else {
      const label = r.mode === "metro" ? "metro station" : "bus stop";
      const served = r.servedKm2 || 1;
      const i5 = BANDS.indexOf(5), i10 = BANDS.indexOf(10);
      body.append(el("h3", { class: "sub", text: `Walking distance to the nearest ${label}` }),
                  bandTable(r));
      body.append(el("div", { class: "insight" },
        el("strong", { text: `${((r.areasKm2[i10] / served) * 100).toFixed(0)}% of the walkable box is within 10 minutes of a ${label}. ` }),
        `${((r.areasKm2[i5] / served) * 100).toFixed(0)}% is within five. The share is computed against `
        + `the ${n1(served)} km² this network can serve at all, not against the whole `
        + `16.1 km² box — a third of which is lawn, carriageway island and walled compound that no `
        + `footway reaches.`));
      if (r.atOrigin !== null && Number.isFinite(r.atOrigin)) {
        body.append(el("div", { class: "metric" },
          el("span", { class: "m-l", text: "From your last starting point" }),
          el("span", { class: "m-v", text: `${n1(r.atOrigin)} min` })));
      }
    }

    // opacity, because the overlay hides the city it is describing
    const op = el("input", { type: "range", min: "15", max: "95",
                             value: String(opacity), class: "slider" });
    op.addEventListener("input", () => {
      opacity = Number((op as HTMLInputElement).value);
      onOpacity(opacity / 100);
    });
    body.append(el("div", { class: "field", style: "margin-top:10px" },
      el("label", { text: "Overlay opacity" }), op));

    body.append(assumptions());
  }

  function routeRow(label: string, colour: string, minutes: number, metres: number,
                    ug: number | null, enrich: number) {
    return el("div", {}, 
      el("div", { class: "metric" },
        el("span", { class: "m-l" },
          el("i", { class: "swatch", style: `background:${colour}` }), label),
        el("span", { class: "m-v", text: `${Math.round(minutes)} min` })),
      el("p", { class: "dnote", style: "margin:0 0 7px" },
        `${Math.round(metres)} m on foot · mean kerbside enrichment ×${enrich.toFixed(3)}`
        + (ug !== null ? ` · ${ug.toFixed(1)} µg inhaled` : "")));
  }

  function renderRoute() {
    if (waitingFor) {
      body.append(el("div", { class: "insight" },
        el("strong", { text: waitingFor === "start" ? "Click a starting point. " : "Now click a destination. " }),
        waitingFor === "start"
          ? "Then click where you are going. Both routes are computed at once, on the same network."
          : "The quickest walk minimises minutes. The other minimises minutes × kerbside enrichment, which is inhaled dose under this model. Where they differ, you can see it."));
    }
    if (routeError) body.append(el("div", { class: "disabled-reason", text: routeError }));

    if (pair) {
      const p = pair;
      body.append(el("h3", { class: "sub", text: "Two ways to walk it" }));
      body.append(routeRow("Quickest", ROUTE_COLOUR.time, p.fastest.minutes, p.fastest.metres,
                           p.ug?.fastest ?? null, p.fastest.meanEnrich));
      body.append(routeRow("Lowest dose", ROUTE_COLOUR.dose, p.cleanest.minutes, p.cleanest.metres,
                           p.ug?.cleanest ?? null, p.cleanest.meanEnrich));

      // The headline is the measured ceiling, not this one journey. Presenting a 0.3% difference as
      // "your cleaner option" would imply a choice worth making, and there isn't one.
      body.append(el("h3", { class: "sub", text: "What that is worth" }));
      if (p.identical) {
        body.append(el("p", { class: "note" },
          el("strong", { text: "Identical routes. " }),
          "There is no lower-dose way to make this particular walk."));
      } else {
        body.append(el("p", { class: "note" },
          el("strong", { text: `${(p.doseSavedFrac * 100).toFixed(1)}% less inhaled, `
                               + (p.extraMinutes <= 0.05 ? "at no extra time. "
                                  : `for ${n1(p.extraMinutes)} extra minutes. `) }),
          p.ug
            ? `That is ${(p.ug.fastest - p.ug.cleanest).toFixed(2)} µg of PM2.5, against `
              + `${p.ug.fastest.toFixed(1)} µg for the walk itself.`
            : "A proportional difference; no air reading is available to put a mass on it."));
      }

      body.append(el("div", { class: "insight" },
        el("strong", { text: "Route choice is not the lever here — measured, not assumed. " }),
        "Over 149 random journeys across this network, only 21 had a different lowest-dose route "
        + "at all, the median saving was 0%, and the best available anywhere was ",
        el("b", { text: "2.2%" }),
        ". The reason is physical: PM2.5 in Delhi is dominated by the regional background, so the "
        + "extra you breathe from being at the kerb rather than 50 m back is a small perturbation "
        + "on a number already several times the WHO guideline. A pollutant with a steeper "
        + "roadside gradient — NO₂, black carbon, ultrafines — would answer differently, and this "
        + "model does not cover them."));

      body.append(el("p", { class: "note" },
        el("strong", { text: "What does move the number. " }),
        "Duration and breathing rate, which is a question of mode, and the hour you travel — the "
        + "forecast scan in Air & exposure regularly finds a 15% or better dip within the working "
        + "day. Both are larger levers than any street you could pick."));

      if (p.cleanest.stepMinutes > 0.1 || p.fastest.stepMinutes > 0.1) {
        body.append(el("p", { class: "dnote" },
          `Includes stepped ways: ${n1(p.fastest.stepMinutes)} min on the quickest route, `
          + `${n1(p.cleanest.stepMinutes)} min on the lowest-dose one. Neither is step-free.`));
      }

      const again = el("button", { class: "btn", style: "margin-top:9px", text: "Pick two new points" });
      again.addEventListener("click", () => { pair = null; routeError = null; waitingFor = "start";
                                              onClear(); render(); });
      body.append(again);
    }
    body.append(assumptions());
  }

  function assumptions() {
    const ul = el("ul", { class: "limits" },
      el("li", { text: "The network is observed OSM geometry. The minutes are a declared heuristic: 4.8 km/h on the level, 1.6 km/h on ways tagged highway=steps." }),
      el("li", { text: "No crossing or signal delay is charged. Waiting to cross a main road is real time this field gives you for free, so reach is over-stated on any route that crosses one." }),
      el("li", { text: "The last leg from the nearest mapped way is charged as a straight line and capped at 70 m. Beyond that a place is left blank rather than guessed at." }),
      el("li", { text: "A footway that ends at the kerb is joined to the carriageway by a perpendicular connector. Stepping off a kerb is real; a few of these joins will not be." }),
      el("li", { text: "A mapped footway is not a walkable footway. Nothing here knows whether it is parked on, dug up, or missing behind the line." }));
    if (mode === "route") {
      ul.append(
        el("li", { text: "Kerbside enrichment is a declared geometric heuristic: a near-road gradient decaying with a 45 m length scale from a peak taken from the exposure model's in_traffic figure, scaled by road class as a proxy for traffic volume. It is not a pollution measurement and cannot be — there is one modelled concentration for the whole box." }),
        el("li", { text: "Because that concentration is uniform, only the ratio between the two routes carries information. The microgram figures inherit every limitation of the air reading underneath them." }),
        el("li", { text: "Road class stands in for traffic volume because no counts exist for these streets, so a quiet secondary road and a jammed one are treated the same." }),
        el("li", { text: "Nothing here weighs shade, surface, lighting, crowding or safety — all of which most people would rank above a small difference in particulate." }));
    }
    if (graph) {
      const st = graph.stats;
      ul.prepend(el("li", { text:
        `Graph: ${st.nodes.toLocaleString()} nodes and ${st.edges.toLocaleString()} edges from `
        + `${st.roadWays} road ways and ${st.footWays} footway ways, of which ${st.stepEdges} edges `
        + `are stepped. ${st.stitched} dangling way ends were joined to the nearest way within 15 m `
        + `(${st.split} segment splits). Without that step the graph is 45% connected and every `
        + `answer here is wrong; the figure moves only 4 points across an 8–28 m tolerance, so it is `
        + `the projection doing the work rather than a generous threshold.` }));
      ul.prepend(el("li", { text:
        `${st.largestComponentPct.toFixed(1)}% of nodes sit in one connected component, in `
        + `${st.components} components overall. Anything outside the main component is unreachable `
        + `at any distance — a data limit, not a barrier on the ground.` }));
    }
    return el("div", {}, el("h3", { class: "sub", text: "Assumptions" }), ul);
  }

  function show() { node.classList.remove("hidden"); render(); }
  function hide() { node.classList.add("hidden"); }

  return {
    node, show, hide,
    toggle() { node.classList.contains("hidden") ? show() : hide(); },
    isOpen: () => !node.classList.contains("hidden"),
    get mode() { return mode; },
    /** used by the test surface, which addresses a question directly rather than clicking the
     *  picker. Without it the panel stayed on the walk view and rendered no route at all. */
    setMode(m: ReachMode) { mode = m; if (!node.classList.contains("hidden")) render(); },
    setGraph(g: Graph) { graph = g; },
    setBusy(b: boolean) { busy = b; if (!node.classList.contains("hidden")) render(); },
    /** the route mode is a two-click interaction, so the panel has to say which click it wants */
    setRoutePrompt(w: "start" | "destination" | null) {
      waitingFor = w;
      if (w) { pair = null; routeError = null; }
      if (!node.classList.contains("hidden")) render();
    },
    setRoutePair(p: RoutePair | { error: string } | null) {
      waitingFor = null;
      if (p && "error" in p) { routeError = p.error; pair = null; } else { routeError = null; pair = p; }
      if (!node.classList.contains("hidden")) render();
    },
    setResult(r: ReachResult | { error: string } | null) {
      busy = false;
      if (r && "error" in r) { error = r.error; result = null; } else { error = null; result = r; }
      if (!node.classList.contains("hidden")) render();
    },
  };
}
