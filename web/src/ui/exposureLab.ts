import { el, clear } from "./dom";
import { store } from "../state/store";
import type { CorridorMetrics } from "../scenario/engine";
import type { ExposureModel, JourneyExposure } from "../scenario/exposure";
import { journeys, betterTimeToTravel, whoContext, pmColour } from "../scenario/exposure";
import type { AirReading, AirForecastHour, WeatherReading,
              MixingHour } from "../data/adapters/openMeteo";
import { airContext } from "../scenario/airContext";
import type { Corridor } from "../geo/types";

const n1 = (v: number) => v.toFixed(1);

export interface ExposureState {
  air: AirReading | null;
  forecast: AirForecastHour[];
  weather: WeatherReading | null;
  mixing: MixingHour[];
  /** true when `air` came from the pinned snapshot rather than the network */
  fromSnapshot: boolean;
  snapshotNote: string;
}

/**
 * The panel that answers "how much of this will I breathe, and is there a better way or hour".
 *
 * Everything here hangs off one observed number. So the panel leads with that number, its source
 * and its age — and if it came from the pinned snapshot instead of the live feed, it says so before
 * showing a single dose figure.
 */
export function exposureLab(
  corridors: Corridor[],
  model: ExposureModel | null,
  onCorridor: (id: string) => void,
) {
  const body = el("div", { class: "pbody" });
  const badge = el("span", { class: "badge base", text: "—" });
  const node = el("aside", { class: "panel hidden", id: "exposure" },
    el("div", { class: "phead" }, el("h2", { text: "Exposure" }), badge), body);
  const closeBtn = el("button", { class: "chip", text: "Close" });
  (node.querySelector(".phead") as HTMLElement).append(closeBtn);
  closeBtn.addEventListener("click", () => hide());

  let air: ExposureState = { air: null, forecast: [], weather: null, mixing: [],
                             fromSnapshot: true, snapshotNote: "" };
  let metrics: CorridorMetrics | null = null;

  function doseRow(j: JourneyExposure, worst: number) {
    if (!j.available) {
      return el("div", { class: "exrow" },
        el("span", { class: "ex-mode", text: j.label }),
        el("span", { class: "ex-none", text: j.unavailableReason ?? "unavailable" }));
    }
    const pct = worst > 0 ? Math.max((j.dose_ug / worst) * 100, 2) : 0;
    return el("div", { class: "exrow" },
      el("span", { class: "ex-mode", text: j.label }),
      el("span", { class: "ex-bar" }, el("i", { style: `width:${pct.toFixed(0)}%` })),
      el("span", { class: "ex-dose", text: `${n1(j.dose_ug)} µg` }),
      el("span", { class: "ex-min", text: `${Math.round(j.totalMinutes)} min` }));
  }

  function render() {
    const s = store.get();
    clear(body);

    if (!model) {
      body.append(el("div", { class: "disabled-reason",
        text: "The scenario model did not load, so no exposure figure can be produced." }));
      return;
    }
    if (!air.air) {
      body.append(el("div", { class: "disabled-reason" },
        el("strong", { text: "No air-quality reading. " }),
        "Neither the live feed nor the pinned snapshot is available, so there is nothing to compute a dose from. Everything else in the app is unaffected."));
      badge.className = "badge base"; badge.textContent = "no data";
      return;
    }

    const a = air.air;
    const who = whoContext(a.pm2_5, model);

    // ---- the observed number comes first, with its provenance, before any derived figure
    badge.className = air.fromSnapshot ? "badge est" : "badge base";
    badge.textContent = air.fromSnapshot ? "snapshot" : a.state;

    body.append(
      el("div", { class: "pmhead", style: `border-left-color:${pmColour(a.pm2_5)}` },
        el("div", { class: "pmnum" },
          el("b", { text: n1(a.pm2_5) }),
          el("span", { text: " µg/m³ PM2.5" })),
        el("div", { class: "pmwho", text: who.plain })),
      el("p", { class: "note", style: "margin-top:8px;font-size:11.5px" },
        el("span", { class: "badge base", text: "observed" }), " ",
        `${a.provider} · ${a.source_time}`),
    );

    if (air.fromSnapshot) {
      body.append(el("div", { class: "disabled-reason", style: "margin-top:8px" },
        el("strong", { text: "Pinned snapshot, not a live reading. " }), air.snapshotNote));
    }

    // ---- WHY. This sits immediately under the number, before any dose figure, because
    // "71 µg/m³" is a verdict and this is the information.
    const ctx = airContext(a, air.weather, air.mixing);
    body.append(el("h3", { class: "sub", text: "Why the air is like this" }));
    body.append(el("div", { class: "insight" }, el("strong", { text: ctx.headline })));

    if (ctx.ventilation) {
      const v = ctx.ventilation;
      body.append(el("div", { class: "metric" },
        el("span", { class: "m-l", text: "Mixing layer" }),
        el("span", { class: "m-v", text: `${Math.round(v.blh_m)} m` })));
      body.append(el("div", { class: "metric" },
        el("span", { class: "m-l", text: "Ventilation index" }),
        el("span", { class: `m-v vent-${v.band.replace(" ", "-")}`,
                     text: `${Math.round(v.index).toLocaleString()} m²/s · ${v.band}` })));
      body.append(el("p", { class: "dnote", text: v.plain }));
      if (v.best && v.liftFactor && v.liftFactor > 1.3) {
        body.append(el("p", { class: "dnote" },
          "The deepest mixing in the next 12 hours of this forecast is ",
          el("b", { text: `${Math.round(v.best.blh_m)} m at ${v.best.time.slice(11, 16)}` }),
          ` — about ${v.liftFactor.toFixed(1)}× the dilution available now. Dilution, rather than `
          + `a change in what the city emits, is what moves this number hour to hour. A forecast, `
          + `not an observation.`));
      }
    } else {
      body.append(el("p", { class: "note",
        text: "No mixing-layer data in this reading, so the meteorological half of the explanation "
            + "is unavailable." }));
    }

    body.append(el("div", { class: "metric" },
      el("span", { class: "m-l", text: "Fine fraction (PM2.5/PM10)" }),
      el("span", { class: "m-v",
                   text: ctx.attribution.finePct === null ? "—"
                       : `${ctx.attribution.finePct.toFixed(0)}% · ${ctx.attribution.kind}` })));
    body.append(el("p", { class: "dnote", text: ctx.attribution.reading }));

    if (ctx.windFrom) {
      body.append(el("div", { class: "metric" },
        el("span", { class: "m-l", text: "Air arriving from" }),
        el("span", { class: "m-v",
                     text: `${ctx.windFrom.name} · ${Math.round(ctx.windFrom.deg)}°` })));
      body.append(el("p", { class: "dnote", text: ctx.windFrom.note }));
    }
    if (ctx.aod !== null && ctx.aodNote) {
      body.append(el("div", { class: "metric" },
        el("span", { class: "m-l", text: "Haze column (AOD)" }),
        el("span", { class: "m-v", text: ctx.aod.toFixed(2) })));
      body.append(el("p", { class: "dnote", text: ctx.aodNote }));
    } else if (air.fromSnapshot) {
      body.append(el("p", { class: "dnote",
        text: "Dust, haze column and mixing depth are not in the pinned snapshot — they arrive "
            + "only with the live feed." }));
    }

    body.append(el("h3", { class: "sub", text: "Other pollutants" }),
      el("div", { class: "kv" },
        el("dt", { text: "PM10" }), el("dd", { class: "num", text: `${n1(a.pm10)} µg/m³` }),
        el("dt", { text: "NO₂" }), el("dd", { class: "num", text: `${n1(a.no2)} µg/m³` }),
        el("dt", { text: "O₃" }), el("dd", { class: "num", text: `${n1(a.o3)} µg/m³` }),
        el("dt", { text: "SO₂" }), el("dd", { class: "num", text: `${n1(a.so2)} µg/m³` })));

    // ---- corridor picker
    const pick = el("div", { class: "field" }, el("label", { text: "Journey along" }));
    const row = el("div", { class: "row", style: "flex-wrap:wrap;gap:4px" });
    for (const c of corridors) {
      const b = el("button", {
        class: s.activeCorridor === c.id ? "btn on" : "btn",
        style: "font-size:11px;padding:5px 8px", text: c.label,
      });
      b.addEventListener("click", () => onCorridor(c.id));
      row.append(b);
    }
    pick.append(row);
    body.append(pick);

    if (!metrics) {
      body.append(el("p", { class: "note", text: "Select a corridor to compare modes." }));
      return;
    }

    const corridor = corridors.find((c) => c.id === metrics!.corridorId);
    const js = journeys({
      pm2_5: a.pm2_5, metrics, corridorLengthM: corridor?.spine_len ?? 1000,
      model, transitAvailable: metrics.waitProxyMin !== null,
    });
    const worst = Math.max(...js.filter((j) => j.available).map((j) => j.dose_ug), 1);
    const best = js.filter((j) => j.available).reduce((x, y) => (y.dose_ug < x.dose_ug ? y : x));

    body.append(el("h3", { class: "sub", text: `Inhaled PM2.5 for this journey` }));
    for (const j of js) body.append(doseRow(j, worst));

    body.append(el("p", { class: "note", style: "margin-top:9px" },
      el("span", { class: "badge sim", text: "estimated" }), " ",
      `Lowest here is ${best.label.toLowerCase()} at ${n1(best.dose_ug)} µg — about `,
      el("b", { text: `${(best.whoDayFraction * 100).toFixed(0)}%` }),
      " of a whole day at the WHO guideline, or roughly ",
      el("b", { text: best.cigarettes.toFixed(2) }),
      " cigarettes' worth of particulate by the usual equivalence."));

    // ---- the leg breakdown, which is where the actual insight lives
    const bus = js.find((j) => j.mode === "bus");
    if (bus?.available && bus.legs.length === 2) {
      const wait = bus.legs[0];
      const waitShare = (wait.dose_ug / bus.dose_ug) * 100;
      body.append(el("h3", { class: "sub", text: "Where the bus dose comes from" }));
      for (const l of bus.legs) {
        body.append(el("div", { class: "metric" },
          el("span", { class: "m-l", text: l.what }),
          el("span", { class: "m-v", text: `${n1(l.dose_ug)} µg` })));
        body.append(el("p", { class: "dnote", text: l.enrichmentWhy }));
      }
      if (waitShare > 40) {
        body.append(el("div", { class: "insight" },
          el("strong", { text: `Waiting is ${waitShare.toFixed(0)}% of the dose. ` }),
          `You breathe harder standing than sitting, and kerbside air is worse than the background. `
          + `Halving the wait would cut about ${n1(wait.dose_ug / 2)} µg — which makes bus frequency `
          + `an air-quality intervention, not only a wait-time one. Run the bus-frequency scenario `
          + `in the Scenario Lab and watch this number move.`));
      } else {
        body.append(el("p", { class: "note",
          text: `Riding accounts for most of the dose here (${(100 - waitShare).toFixed(0)}%), because the wait is already short relative to the ride.` }));
      }
    }

    // ---- the cheapest intervention anyone has: go later
    const better = betterTimeToTravel(a.pm2_5, air.forecast);
    body.append(el("h3", { class: "sub", text: "A better hour" }));
    if (better) {
      body.append(el("div", { class: "insight" },
        el("strong", { text: `${better.time.slice(11, 16)} looks ${better.reductionPct.toFixed(0)}% cleaner. ` }),
        `Forecast PM2.5 falls to ${n1(better.pm2_5)} µg/m³ in about `
        + `${better.hoursAway.toFixed(0)} hour${better.hoursAway < 1.5 ? "" : "s"}. `
        + `Shifting the same trip there cuts the dose by roughly the same share.`));
    } else {
      body.append(el("p", { class: "note",
        text: air.forecast.length
          ? "Nothing materially cleaner in the next 14 hours — the forecast stays within 15% of now, so shifting the trip would not help much."
          : "No forecast available, so no alternative hour can be suggested." }));
    }

    body.append(el("h3", { class: "sub", text: "Assumptions" }),
      el("ul", { class: "limits" },
        el("li", { text: `Exposure model v${model.version}. Dose = concentration × ventilation × minutes × penetration × kerbside enrichment.` }),
        el("li", { text: `Ventilation: sitting ${model.ventilation_m3_per_min.sitting}, standing ${model.ventilation_m3_per_min.standing}, walking ${model.ventilation_m3_per_min.walking}, cycling ${model.ventilation_m3_per_min.cycling} m³/min. Mid-range adult values; individual rates vary widely.` }),
        el("li", { text: `Penetration: bus ${model.penetration.bus}, car on recirculation ${model.penetration.car_recirculating}, on foot ${model.penetration.outdoor}.` }),
        el("li", { text: `Kerbside enrichment: waiting ×${model.roadside_enrichment.waiting_at_stop}, footway ×${model.roadside_enrichment.walking_footway}, in traffic ×${model.roadside_enrichment.in_traffic}. Declared multipliers, not measurements at these locations.` }),
        el("li", { text: "The concentration is one modelled reading for the whole study area — not a kerbside monitor, and it cannot resolve variation inside a 4 km box." }),
        el("li", { text: "Travel and wait times come from the corridor estimate, which is itself a declared heuristic rather than observed speeds." }),
        el("li", { text: "Not medical advice. A dose figure is a rough comparative indicator, not a personal health assessment." }),
        ...ctx.limitations.map((t) => el("li", { text: t }))));
  }

  function show() { node.classList.remove("hidden"); render(); }
  function hide() { node.classList.add("hidden"); }
  function toggle() { node.classList.contains("hidden") ? show() : hide(); }

  return {
    node, show, hide, toggle,
    setAir(a: ExposureState) { air = a; if (!node.classList.contains("hidden")) render(); },
    setMetrics(mm: CorridorMetrics | null) { metrics = mm; if (!node.classList.contains("hidden")) render(); },
    refresh: render,
    isOpen: () => !node.classList.contains("hidden"),
  };
}
